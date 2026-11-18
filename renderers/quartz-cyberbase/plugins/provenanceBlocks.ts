// Source fallback blocks are captured BEFORE Markdown transforms, never inferred
// from visible text. This module has no filesystem access or renderer imports.
import {
  MAX_PROVENANCE_BLOCK_BYTES,
  type ProvenanceBlock,
} from "./provenanceContract";

type Node = any;
type Span = { s: number; e: number } | null;
export type CapturedBlock = {
  id: string;
  page: string;
  source: [number, number];
  reason?: string;
};
const visit = (
  node: Node,
  fn: (node: Node, ancestors: Node[]) => void,
  ancestors: Node[] = [],
) => {
  fn(node, ancestors);
  for (const child of node.children ?? [])
    visit(child, fn, [...ancestors, node]);
};
const callout = (node: Node) =>
  node.type === "blockquote" &&
  /^\[!\w+/.test(node.children?.[0]?.children?.[0]?.value ?? "");
const leafItem = (node: Node) =>
  node.type === "listItem" &&
  !(node.children ?? []).some((child: Node) => child.type === "list");
function blockKind(node: Node, ancestors: Node[]): string | undefined {
  if (ancestors.some((n) => callout(n) || leafItem(n) || n.type === "table"))
    return;
  if (callout(node)) return "callout";
  if (leafItem(node)) return "listItem";
  if (
    ["paragraph", "heading", "table", "math", "code", "thematicBreak"].includes(
      node.type,
    )
  )
    return node.type;
}
function byteOffsets(raw: string) {
  const offsets = Array(raw.length + 1).fill(-1);
  let index = 0,
    bytes = 0;
  offsets[0] = 0;
  for (const char of raw) {
    index += char.length;
    bytes += new TextEncoder().encode(char).length;
    offsets[index] = bytes;
  }
  return offsets;
}
function bounds(node: Node, map: Span[]): [number, number] | undefined {
  const start = node.position?.start?.offset,
    end = node.position?.end?.offset;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > map.length
  )
    return;
  const spans = map
    .slice(start, end)
    .filter((s): s is NonNullable<Span> => s !== null);
  if (!spans.length) return;
  // Preprocessing can insert nulls or remove comments, but may never reorder source.
  for (let i = 1; i < spans.length; i++)
    if (spans[i].s < spans[i - 1].s || spans[i].e < spans[i - 1].e) return;
  return [spans[0].s, spans.at(-1)!.e];
}
function hiddenReason(node: Node, text: string): string | undefined {
  // Deliberately conservative, including escaped/code examples and unmatched
  // delimiters: the fallback never ships a possible hidden comment to a browser.
  if (text.includes("%%")) return "obsidian-comment";
  if (text.includes("<!--")) return "html-comment";
  if (text.includes("![[")) return "transclusion";
  let reason: string | undefined;
  visit(node, (n) => {
    if (n.type === "html") reason = "raw-html";
    if (n.type === "image" || n.type === "imageReference")
      reason = "transclusion";
    if (["definition", "footnoteDefinition", "yaml", "toml"].includes(n.type))
      reason = "unpublished-source";
  });
  return reason;
}

/** Parse original trimmed input with the SAME parser/extensions, without running
 * its transforms. Original parser boundaries retain comments removed by OFM.
 * The published projection is required to be verbatim; no canonical-file reads.
 */
export function captureSourceBlocks(
  raw: string,
  originalTree: Node,
  originalMap: Span[],
  transformedTree: Node,
  transformedMap: Span[],
  page: string,
): CapturedBlock[] {
  const offsets = byteOffsets(raw);
  const originals: {
    node: Node;
    kind: string;
    start: number;
    end: number;
    reason?: string;
  }[] = [];
  visit(originalTree, (node, ancestors) => {
    const kind = blockKind(node, ancestors);
    const range = kind && bounds(node, originalMap);
    if (!kind || !range) return;
    let [start, end] = range;
    // Include the leading quote marker when the paragraph is the source block.
    // Continuation-line markers are already inside the parser's range.
    if (
      kind === "paragraph" &&
      ancestors.some((n) => n.type === "blockquote")
    ) {
      const line = raw.lastIndexOf("\n", start - 1) + 1;
      if (/^[ \t>]+$/.test(raw.slice(line, start))) start = line;
    }
    originals.push({
      node,
      kind,
      start,
      end,
      reason: hiddenReason(node, raw.slice(start, end)),
    });
  });
  const captured: CapturedBlock[] = [];
  visit(transformedTree, (node, ancestors) => {
    const kind = blockKind(node, ancestors);
    const range = kind && bounds(node, transformedMap);
    if (!kind || !range) return;
    const [start, end] = range;
    const matches = originals.filter(
      (original) =>
        original.kind === kind &&
        original.start <= start &&
        original.end >= end,
    );
    // Do not guess when preprocessing merged/split source blocks. Retain a
    // non-editable locator for the transformed block, but emit no source text.
    const original = matches.length === 1 ? matches[0] : undefined;
    const source: [number, number] = [
      offsets[original?.start ?? start],
      offsets[original?.end ?? end],
    ];
    if (
      source.some((n) => !Number.isInteger(n) || n < 0) ||
      source[1] <= source[0]
    )
      return;
    let reason = original ? original.reason : "transformed-boundary";
    if (!reason && source[1] - source[0] > MAX_PROVENANCE_BLOCK_BYTES)
      reason = "too-large";
    const block: CapturedBlock = {
      id: `block${captured.length}`,
      page,
      source,
      ...(reason ? { reason } : {}),
    };
    node._cbBlock = block;
    captured.push(block);
  });
  return captured;
}

const transcluded = (node: Node) =>
  String(node.properties?.className ?? "")
    .split(/[ ,]+/)
    .includes("transclude");
/** Run after leaf annotation, which strips all authored data-cb-* attributes. */
export function renderedSourceBlocks(
  tree: Node,
  raw: string,
  page: string,
): ProvenanceBlock[] {
  const bytes = new TextEncoder().encode(raw);
  const located = new Map<
    string,
    { node: Node; block: CapturedBlock; rawHtml: boolean }[]
  >();
  visit(tree, (node, ancestors) => {
    const block: CapturedBlock | undefined = node._cbBlock;
    // Foreign content, including same-file transclusions, never inherits authority.
    if (
      node.type !== "element" ||
      !block ||
      block.page !== page ||
      ancestors.some(transcluded)
    )
      return;
    const matches = located.get(block.id) ?? [];
    matches.push({
      node,
      block,
      rawHtml: [node, ...ancestors].some((n) => n._cbRawHtml),
    });
    located.set(block.id, matches);
  });
  const result: ProvenanceBlock[] = [];
  for (const matches of located.values()) {
    if (matches.length !== 1) continue; // duplicated/rewritten DOM boundary: no claim
    const { node, block, rawHtml } = matches[0];
    const parent = node.properties["data-cb-node"] ?? `cb-${block.id}`;
    node.properties["data-cb-node"] = parent;
    const reason = transcluded(node)
      ? "transclusion"
      : (block.reason ?? (rawHtml ? "raw-html" : undefined));
    const base = { id: block.id, parent, source: block.source };
    if (reason) result.push({ ...base, editable: false, reason });
    else {
      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes.subarray(...block.source));
      // Defense in depth at the actual emission boundary.
      if (text.includes("%%") || text.includes("<!--"))
        result.push({ ...base, editable: false, reason: "hidden-content" });
      else result.push({ ...base, editable: true, text });
    }
  }
  return result;
}

/** Known renderer replacement (KaTeX): transfer only across exact sibling slots.
 * Every changed slot must be a math pre replaced by one KaTeX element; all other
 * sibling object identities must survive. No matching by source text.
 */
export function blockReplacementSnapshot(tree: Node) {
  const slots: { parent: Node; children: Node[]; node: Node; index: number }[] =
    [];
  visit(tree, (parent) => {
    parent.children?.forEach((node: Node, index: number) => {
      if (node._cbBlock)
        slots.push({ parent, children: [...parent.children], node, index });
    });
  });
  return () => {
    for (const { parent, children, node, index } of slots) {
      if (
        parent.children.includes(node) ||
        parent.children.length !== children.length
      )
        continue;
      const mathReplacement = (old: Node, next: Node) =>
        old.tagName === "pre" &&
        old.children?.some((child: Node) =>
          String(child.properties?.className ?? "")
            .split(/[ ,]+/)
            .some((c: string) => ["language-math", "math-display"].includes(c)),
        ) &&
        next?.type === "element" &&
        next.tagName === "span" &&
        String(next.properties?.className ?? "")
          .split(/[ ,]+/)
          .some((c) => ["katex-display", "katex-error"].includes(c));
      if (
        children.some(
          (sibling, i) =>
            parent.children[i] !== sibling &&
            !mathReplacement(sibling, parent.children[i]),
        )
      )
        continue;
      const next = parent.children[index];
      if (!next._cbBlock) next._cbBlock = node._cbBlock;
    }
  };
}
