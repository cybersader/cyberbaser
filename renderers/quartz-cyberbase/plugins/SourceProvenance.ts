// @ts-nocheck
// Opt-in adapter for hash-attested Quartz 4.5.2. No global mutation or external source reads.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { defaultHandlers } from "mdast-util-to-hast";
import {
  annotateHast,
  annotateInitial,
  markProvenanceFailed,
  joinSpan,
  walk,
  wrap,
} from "./provenanceCore";
import { trimmedSource, mapOfm } from "./provenanceText";
import { captureSourceBlocks, renderedSourceBlocks } from "./provenanceBlocks";
import {
  emitProvenance,
  type ProvenanceSink,
  type ProvenanceLeaf,
  type ProvenanceRun,
} from "./provenanceContract";
import type { QuartzTransformerPluginInstance } from "../plugins/types";

export function provenanceMode(value: string | undefined): boolean {
  if (value === undefined || value === "disabled") return false;
  if (value === "enabled") return true;
  throw Error("CYBERBASER_SOURCE_PROVENANCE must be 'enabled' or 'disabled'");
}
const digest = (bytes: Uint8Array) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
function byteOffsets(raw: string) {
  const offsets = Array(raw.length + 1).fill(-1);
  let i = 0,
    b = 0;
  offsets[0] = 0;
  for (const char of raw) {
    b += Buffer.byteLength(char);
    i += char.length;
    offsets[i] = b;
  }
  return offsets;
}
function blocked(ancestors: any[], node: any): string | undefined {
  const classes = ancestors.map((n) => String(n.properties?.className ?? ""));
  if (classes.some((c) => c.split(/[ ,]+/).includes("transclude")))
    return "transclusion";
  if (classes.some((c) => c.includes("callout-title"))) return "callout-title";
  if (
    classes.some((c) => c.includes("katex")) ||
    ancestors.some((n) => n.tagName === "math")
  )
    return "math";
  if (classes.some((c) => c.includes("tag-link")) || node._kind === "tag")
    return "target-derived-tag";
  if (node._kind === "wikilink target") return "target-derived-wikilink";
  if (node._kind === "embed") return "transclusion";
  if (
    ancestors.some((n) => ["script", "style", "textarea"].includes(n.tagName))
  )
    return "raw-text-element";
}
// Adjacent HAST text nodes serialize as ONE browser text node. Merge their maps too.
function mergeText(tree: any) {
  for (const node of tree.children ?? []) mergeText(node);
  if (!tree.children) return;
  const children: any[] = [];
  for (const node of tree.children) {
    // Quartz's HAST-to-JSX body renderer omits comments. Match its actual DOM
    // before coalescing adjacent text and assigning childNodes indices.
    if (node.type === "comment") continue;
    const previous = children.at(-1);
    if (node.type === "text" && previous?.type === "text") {
      const map = (n: any) =>
        n._kind === "wikilink target" || n._kind === "tag"
          ? Array(n.value.length).fill(null)
          : (n._prov ?? Array(n.value.length).fill(null));
      previous._prov = [...map(previous), ...map(node)];
      previous.value += node.value;
      delete previous._kind;
    } else children.push(node);
  }
  tree.children = children;
}
export function annotateRenderedBody(tree: any, raw: string): ProvenanceLeaf[] {
  // HTML tokenization normalizes literal CR/CRLF to LF, even when rehype-raw
  // retained a CR via its virtual numeric entity. Describe the browser text.
  walk(tree, (node) => {
    if (node.type !== "text" || !node.value.includes("\r")) return;
    let text = "";
    const map = [];
    for (let i = 0; i < node.value.length; ) {
      const length =
        node.value[i] === "\r" && node.value[i + 1] === "\n" ? 2 : 1;
      text += node.value[i] === "\r" ? "\n" : node.value[i];
      map.push(
        joinSpan(
          (node._prov ?? Array(node.value.length).fill(null)).slice(
            i,
            i + length,
          ),
          "line-ending",
        ),
      );
      i += length;
    }
    node.value = text;
    node._prov = map;
  });
  mergeText(tree);
  // Source-authored attributes never masquerade as adapter-generated locators.
  walk(tree, (n) => {
    for (const key of Object.keys(n.properties ?? {})) {
      if (/^data-?cb-?/i.test(key)) delete n.properties[key];
    }
  });
  const offsets = byteOffsets(raw);
  const bytes = Buffer.from(raw);
  const leaves: ProvenanceLeaf[] = [];
  let sequence = 0;
  function descend(parent: any, ancestors: any[]) {
    if (!parent.children) return;
    const texts = parent.children.some((n: any) => n.type === "text");
    const id =
      parent.type === "root" ? "$body" : texts ? `cb${sequence++}` : undefined;
    if (texts && parent.type === "element")
      parent.properties["data-cb-node"] = id;
    parent.children.forEach((node: any, child: number) => {
      if (node.type !== "text") {
        descend(node, [...ancestors, node]);
        return;
      }
      const reason = blocked(ancestors, node);
      const runs: ProvenanceRun[] = [];
      let from = 0;
      for (const char of node.value) {
        const to = from + char.length;
        const sp = reason ? null : node._prov?.[from];
        const start = sp && offsets[sp.s],
          end = sp && offsets[sp.e];
        const complete =
          sp &&
          node._prov.length >= to &&
          node._prov
            .slice(from, to)
            .every((part) => part && part.s === sp.s && part.e === sp.e);
        const valid =
          complete &&
          Number.isInteger(start) &&
          Number.isInteger(end) &&
          start >= 0 &&
          end > start &&
          end <= bytes.length;
        const run: ProvenanceRun = valid
          ? {
              rendered: [from, to],
              source: [start, end],
              kind:
                bytes.subarray(start, end).toString("utf8") === char
                  ? "exact"
                  : "atom",
            }
          : {
              rendered: [from, to],
              reason:
                reason ??
                (/\S/.test(char)
                  ? "generated-or-unmapped"
                  : "generated-whitespace"),
            };
        const previous = runs.at(-1);
        if (
          previous &&
          previous.kind === "exact" &&
          run.kind === "exact" &&
          previous.source![1] === start
        ) {
          previous.rendered[1] = to;
          previous.source![1] = end;
        } else if (
          previous &&
          !previous.source &&
          !run.source &&
          previous.reason === run.reason
        )
          previous.rendered[1] = to;
        else runs.push(run);
        from = to;
      }
      const leaf: ProvenanceLeaf = {
        id: `${id}.${child}`,
        parent: id,
        child,
        text: node.value,
        runs,
      };
      if (runs.length === 1 && runs[0].kind === "exact")
        leaf.exact = runs[0].source;
      leaves.push(leaf);
    });
  }
  descend(tree, []);
  return leaves;
}
function fileSink(ctx: any): ProvenanceSink {
  return {
    write(page, manifest) {
      const file = path.resolve(ctx.argv.output, `${page}.provenance.json`);
      const relative = path.relative(path.resolve(ctx.argv.output), file);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw Error("source provenance output escapes build directory");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Only safety-classified, bounded published block slices carry source text.
      fs.writeFileSync(file, JSON.stringify(manifest) + "\n");
    },
  };
}
/** One note the build emitted without source provenance, and the step that failed. */
export type ProvenanceSkip = { path: string; step: string; error: string };
export type ProvenanceSkipRecorder = (skip: ProvenanceSkip) => void;

/**
 * Default recorder: a count on stderr, and the note paths in the private JSON
 * report named by CYBERBASER_PROVENANCE_REPORT (an absolute path outside the
 * published output). Without that variable only the count is logged.
 */
export function provenanceSkipReport(
  reportPath: string | undefined = process.env.CYBERBASER_PROVENANCE_REPORT,
): ProvenanceSkipRecorder {
  if (reportPath !== undefined && !path.isAbsolute(reportPath))
    throw Error("CYBERBASER_PROVENANCE_REPORT must be an absolute path");
  const notes: ProvenanceSkip[] = [];
  return (skip) => {
    notes.push(skip);
    console.warn(
      `source provenance: note emitted without provenance (${notes.length} so far; ${skip.step})`,
    );
    if (reportPath === undefined) return;
    const report = {
      schema: "cyberbaser.provenance-skipped",
      version: 1,
      count: notes.length,
      notes,
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
  };
}

export function withSourceProvenance(
  transformers: QuartzTransformerPluginInstance[],
  sink?: ProvenanceSink,
  recordSkip: ProvenanceSkipRecorder = provenanceSkipReport(),
): QuartzTransformerPluginInstance[] {
  const capture: QuartzTransformerPluginInstance = {
    name: "SourceProvenance",
    beforeParse(ctx, file, original) {
      const relative = path
        .relative(ctx.argv.directory, file.path)
        .split(path.sep)
        .join("/");
      if (relative.startsWith("../") || path.isAbsolute(relative))
        throw Error("source provenance input escapes content directory");
      const source = {
        path: relative,
        byteLength: original.length,
        sha256: digest(original),
      };
      try {
        const raw = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(original);
        file.data.sourceProvenance = { raw, pre: trimmedSource(raw), source };
      } catch (error) {
        const state: any = { source };
        markProvenanceFailed(state, "decode", error);
        file.data.sourceProvenance = state;
      }
    },
    markdownPlugins() {
      return [
        function () {
          const processor = this;
          return (tree, file) => {
            const state = file.data.sourceProvenance;
            if (!state || state.failed) return;
            try {
              if (state.pre.text !== String(file.value))
                throw Error(
                  "source provenance preprocessing diverged from Quartz",
                );
              annotateInitial(
                tree,
                state.pre.text,
                state.pre.map,
                state.source.path,
              );
              const original = trimmedSource(state.raw);
              captureSourceBlocks(
                state.raw,
                processor.parse(original.text),
                original.map,
                tree,
                state.pre.map,
                state.source.path,
              );
            } catch (error) {
              markProvenanceFailed(state, "markdown", error);
            }
            delete state.pre;
          };
        },
      ];
    },
    htmlHandlers: Object.fromEntries(
      Object.entries({
        ...defaultHandlers,
        // remark-math uses the default unknown handler plus hName/hChildren.
        // Spell out that same handler so its enclosing element gets metadata.
        math(state, node) {
          const result = {
            type: "element",
            tagName: "div",
            properties: {},
            children: state.all(node),
          };
          state.patch(node, result);
          return state.applyData(node, result);
        },
      }).map(([name, handler]) => [
        name,
        (state, node, parent) => {
          const file = state.options?.file;
          const scoped = {
            ...state,
            patch(from, to) {
              state.patch(from, to);
              const note = file?.data?.sourceProvenance;
              if (note?.failed) return;
              try {
                annotateHast(from, to);
              } catch (error) {
                markProvenanceFailed(note, "mdast-to-hast", error);
              }
            },
          };
          const result = handler(scoped, node, parent);
          if (node._cbBlock && result?.type === "element")
            result._cbBlock = node._cbBlock;
          return result;
        },
      ]),
    ),
    finalizeHtml(ctx, tree, data) {
      const state = data.sourceProvenance;
      // Synthetic directory/tag pages have no authoritative source body.
      if (!state) return;
      if (!state.failed) {
        try {
          const leaves = annotateRenderedBody(tree, state.raw);
          const blocks = renderedSourceBlocks(
            tree,
            state.raw,
            state.source.path,
          );
          emitProvenance(
            sink ?? fileSink(ctx),
            data.slug,
            state.source,
            leaves,
            blocks,
          );
          return;
        } catch (error) {
          markProvenanceFailed(state, "finalize", error);
        }
      }
      // The page still renders; the owner review falls back for this note.
      recordSkip({ path: state.source.path, ...state.failed });
    },
  };
  return [
    capture,
    ...transformers.map((plugin) => ({
      ...plugin,
      ...(plugin.textTransform
        ? {
            textTransform(ctx, src, file) {
              const state = file?.data.sourceProvenance;
              const result = plugin.textTransform!(ctx, src, file);
              if (!state || state.failed) return result;
              try {
                if (state.pre.text !== src)
                  throw Error(
                    `missing per-file provenance before ${plugin.name}`,
                  );
                if (plugin.name !== "ObsidianFlavoredMarkdown")
                  throw Error(
                    `no provenance adapter for text transformer ${plugin.name}`,
                  );
                const tracked = mapOfm(state.pre);
                if (tracked.text !== result)
                  throw Error(
                    "pinned OFM preprocessing changed; source provenance fails closed",
                  );
                state.pre = tracked;
              } catch (error) {
                markProvenanceFailed(state, `text:${plugin.name}`, error);
              }
              return result;
            },
          }
        : {}),
      ...(plugin.markdownPlugins
        ? {
            markdownPlugins(ctx) {
              return plugin.markdownPlugins!(ctx).map((p) =>
                wrap(p, `md:${plugin.name}`),
              );
            },
          }
        : {}),
      ...(plugin.htmlPlugins
        ? {
            htmlPlugins(ctx) {
              return plugin.htmlPlugins!(ctx).map((p) =>
                wrap(p, `html:${plugin.name}`),
              );
            },
          }
        : {}),
    })),
  ];
}
