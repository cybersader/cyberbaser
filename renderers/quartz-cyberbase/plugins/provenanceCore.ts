// @ts-nocheck
// Quartz adapter mapping primitives. Adapted from the measured 57-page harness.
// All maps are per-file/per-node data, never global hooks or prototype mutations.
import assert from "node:assert/strict";
import { decodeString } from "micromark-util-decode-string";
import { decodeHTML } from "entities";
import { toHtml } from "hast-util-to-html";
import { blockReplacementSnapshot } from "./provenanceBlocks";
type Span = { s: number; e: number; why?: string };
type Mapping = (Span | null)[];
const walk = (n: any, fn: (n: any, a: any[]) => void, a: any[] = []) => {
  fn(n, a);
  for (const c of n.children ?? []) walk(c, fn, [...a, n]);
};
function originalMap(s: string): Mapping {
  const m: Mapping = [];
  let i = 0;
  for (const c of s) {
    const v = { s: i, e: i + c.length };
    for (let j = 0; j < c.length; j++) m.push(v);
    i += c.length;
  }
  return m;
}
function joinSpan(m: Mapping, why?: string): Span | null {
  if (!m.length || m.some((v) => !v)) return null;
  const a = m as Span[];
  let previous = a[0];
  for (const current of a.slice(1)) {
    // Repeated units of one Unicode scalar/atom, or adjacent source atoms only.
    if (
      !(current.s === previous.s && current.e === previous.e) &&
      current.s !== previous.e
    )
      return null;
    previous = current;
  }
  return { s: a[0].s, e: previous.e, why: why ?? a[0].why };
}
function rewriteMap(
  old: string,
  next: string,
  m: Mapping,
  reason = "rewrite",
): Mapping {
  if (old === next) return m.slice();
  const out: Mapping = Array(next.length).fill(null);
  let i = 0;
  while (i < old.length && i < next.length && old[i] === next[i]) {
    out[i] = m[i];
    i++;
  }
  let a = old.length - 1,
    b = next.length - 1;
  while (a >= i && b >= i && old[a] === next[b]) {
    out[b] = m[a];
    a--;
    b--;
  }
  return out;
}
function emit(out: { text: string; map: Mapping }, v: string, sp: Span | null) {
  out.text += v;
  for (let i = 0; i < v.length; i++) out.map.push(sp);
}
function lexical(
  raw: string,
  m: Mapping,
  html = false,
): { text: string; map: Mapping } {
  const out = { text: "", map: [] as Mapping };
  for (let i = 0; i < raw.length; ) {
    if (html && raw[i] === "\r") {
      const len = raw[i + 1] === "\n" ? 2 : 1;
      emit(out, "\n", joinSpan(m.slice(i, i + len), "line-ending"));
      i += len;
      continue;
    }
    if (
      !html &&
      raw[i] === "\\" &&
      /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(raw[i + 1] ?? "")
    ) {
      emit(out, raw[i + 1], joinSpan(m.slice(i, i + 2), "markdown-escape"));
      i += 2;
      continue;
    }
    if (raw[i] === "&") {
      const hit = raw
        .slice(i)
        .match(/^&(?:#[xX][0-9A-Fa-f]+|#\d+|[A-Za-z][A-Za-z\d]+);/);
      if (hit) {
        const value = html ? decodeHTML(hit[0]) : decodeString(hit[0]);
        if (value !== hit[0]) {
          emit(
            out,
            value,
            [...value].length === 1
              ? joinSpan(m.slice(i, i + hit[0].length), "entity")
              : null,
          );
          i += hit[0].length;
          continue;
        }
      }
    }
    const c = String.fromCodePoint(raw.codePointAt(i)!);
    out.text += c;
    out.map.push(...m.slice(i, i + c.length));
    i += c.length;
  }
  return out;
}
function alignOmissions(
  decoded: { text: string; map: Mapping },
  value: string,
): Mapping | null {
  if (decoded.text === value) return decoded.map;
  let i = 0,
    j = 0;
  const out: Mapping = [];
  let linePrefix = false;
  while (i < decoded.text.length) {
    if (j < value.length && decoded.text[i] === value[j]) {
      out.push(decoded.map[i]);
      linePrefix = decoded.text[i] === "\n";
      i++;
      j++;
      continue;
    }
    const c = decoded.text[i];
    if (/[ \t\r\n]/.test(c) || (linePrefix && c === ">")) {
      if (c === "\n") linePrefix = true;
      i++;
      continue;
    }
    return null;
  }
  return j === value.length ? out : null;
}
function typography(old: string, next: string, m: Mapping): Mapping | null {
  let i = 0,
    j = 0;
  const out: Mapping = [];
  const rules: [string, string][] = [
    [". . .", "…"],
    ["...", "…"],
    ["---", "—"],
    ["--", "—"],
    ["``", "“"],
    ["''", "”"],
    ['"', "“"],
    ['"', "”"],
    ["'", "‘"],
    ["'", "’"],
  ];
  while (i < old.length && j < next.length) {
    if (old[i] === next[j]) {
      out.push(m[i]);
      i++;
      j++;
      continue;
    }
    const r = rules.find(
      ([a, b]) => old.startsWith(a, i) && next.startsWith(b, j),
    );
    if (!r) return null;
    const sp = joinSpan(m.slice(i, i + r[0].length), "smartypants");
    for (let k = 0; k < r[1].length; k++) out.push(sp);
    i += r[0].length;
    j += r[1].length;
  }
  return i === old.length && j === next.length ? out : null;
}
function annotateInitial(
  tree: any,
  text: string,
  preMap: Mapping,
  page: string,
) {
  walk(tree, (n, a) => {
    if (typeof n.value !== "string" || !n.position) return;
    const s = n.position.start.offset,
      e = n.position.end.offset;
    let raw = text.slice(s, e),
      m = preMap.slice(s, e);
    const originalRaw = raw;
    if (n.type === "inlineCode") {
      const fence = raw.match(/^`+/)?.[0] ?? "";
      raw = raw.slice(fence.length, raw.length - fence.length);
      m = m.slice(fence.length, m.length - fence.length);
      // Code spans do not decode entities or escapes.
      const plain = { text: "", map: [] as Mapping };
      for (let i = 0; i < raw.length; ) {
        const len = raw[i] === "\r" && raw[i + 1] === "\n" ? 2 : 1;
        const ch = raw[i] === "\r" || raw[i] === "\n" ? " " : raw[i];
        emit(
          plain,
          ch,
          joinSpan(m.slice(i, i + len), len === 2 ? "line-ending" : undefined),
        );
        i += len;
      }
      if (
        plain.text.startsWith(" ") &&
        plain.text.endsWith(" ") &&
        /[^ ]/.test(plain.text)
      ) {
        plain.text = plain.text.slice(1, -1);
        plain.map = plain.map.slice(1, -1);
      }
      n._prov =
        raw === n.value
          ? m
          : plain.text === n.value
            ? plain.map
            : raw.startsWith(" ") &&
                raw.endsWith(" ") &&
                raw.slice(1, -1) === n.value
              ? m.slice(1, -1)
              : null;
    } else if (n.type === "code") {
      const lines = raw.split(/(?<=\n)/);
      const fence = /^\s*(`{3,}|~{3,})/.test(lines[0] ?? "");
      if (fence) {
        const skip = lines[0].length;
        raw = raw.slice(skip);
        m = m.slice(skip);
        const close = raw.match(
          /(?:\r?\n)?[ \t]*(?:`{3,}|~{3,})[^\r\n]*(?:\r?\n)?$/,
        );
        if (close) {
          raw = raw.slice(0, close.index);
          m = m.slice(0, close.index);
        }
      }
      const d = { text: raw, map: m };
      n._prov =
        alignOmissions(d, n.value) ??
        alignOmissions(lexical(raw, m, true), n.value);
    } else if (n.type === "html")
      // An HTML block nested in a list item or blockquote omits the container's
      // continuation indentation (or "> ") from its value; the source slice keeps it.
      n._prov = raw === n.value ? m : alignOmissions({ text: raw, map: m }, n.value);
    else n._prov = alignOmissions(lexical(raw, m), n.value);
    if (n._prov === null) {
      n._prov = Array(n.value.length).fill(null);
    }
    assert.equal(n._prov.length, n.value.length);
  });
}
function sliceSelected(m: Mapping, start: number, end: number) {
  return m.slice(start, end);
}
export const annotateReplacement = (node: any, match: any, value: any) => {
  if (!node._prov || !value || typeof value !== "object") return;
  const raw = match[0],
    base =
      node._prov?.slice(match.index, match.index + raw.length) ??
      Array(raw.length).fill(null);
  let kind = "generated",
    selected: string | undefined,
    start = -1;
  if (raw.startsWith("![[")) kind = "embed";
  else if (raw.startsWith("[[")) {
    const pipe = raw.lastIndexOf("|");
    if (pipe >= 0) {
      kind = "wikilink alias";
      selected = match[3]?.slice(1).trim();
      start = pipe + 1;
    } else {
      kind = "wikilink target";
      selected = match[1]?.trim() ?? "";
      start = 2;
    }
    if (selected !== undefined && start >= 0) {
      const local = raw.slice(start, raw.length - 2);
      const trim = local.indexOf(selected);
      start += Math.max(0, trim);
    }
  } else if (raw.startsWith("==")) {
    kind = "highlight";
    selected = match[1];
    start = 2;
  } else if (raw.startsWith("#")) {
    kind = "tag";
    selected = match[1];
    start = 1;
  } else kind = "arrow";
  const apply = (v: any) => {
    v._kind = kind;
    if (v.type === "text") {
      if (selected !== undefined && selected === v.value)
        v._prov = sliceSelected(base, start, start + selected.length);
      else if (kind === "tag" && selected) {
        v._prov = rewriteMap(
          selected,
          v.value,
          sliceSelected(base, start, start + selected.length),
          "tag-normalization",
        );
      } else v._prov = Array(v.value?.length ?? 0).fill(null);
    }
    if (v.type === "html" && kind === "arrow") {
      const p = v.value.indexOf(">") + 1;
      const end = v.value.lastIndexOf("<");
      v._prov = Array(v.value.length).fill(null);
      const sp = joinSpan(base, "ofm-arrow");
      for (let z = p; z < end; z++) v._prov[z] = sp;
    }
    if (v.type === "html" && kind === "highlight" && selected !== undefined) {
      const p = v.value.indexOf(">") + 1;
      v._prov = Array(v.value.length).fill(null);
      v._prov.splice(
        p,
        selected.length,
        ...sliceSelected(base, start, start + selected.length),
      );
    }
    for (const c of v.children ?? []) apply(c);
  };
  for (const v of Array.isArray(value) ? value : [value]) apply(v);
};
export const annotateHast = (from: any, to: any) => {
  if (from._kind) to._kind = from._kind;
  if (from._prov && typeof to.value === "string") {
    const old = from.value ?? "";
    if (from.type === "inlineCode" && old !== to.value) {
      const d = { text: "", map: [] as Mapping };
      for (let i = 0; i < old.length; ) {
        const len = old[i] === "\r" && old[i + 1] === "\n" ? 2 : 1;
        const ch = /[\r\n]/.test(old[i]) ? " " : old[i];
        emit(d, ch, joinSpan(from._prov.slice(i, i + len), "code-newline"));
        i += len;
      }
      if (d.text === to.value) {
        to._prov = d.map;
        return;
      }
    }
    to._prov =
      old === to.value
        ? from._prov.slice()
        : (alignOmissions({ text: old, map: from._prov }, to.value) ??
          typography(old, to.value, from._prov) ??
          Array(to.value.length).fill(null));
  }
  if (from.type === "code") {
    to._codeProv = from._prov;
    to._codeValue = from.value;
  }
};
function syncMutation(before: Map<any, any>, tree: any, stage: string) {
  walk(tree, (n) => {
    const b = before.get(n);
    if (!b || typeof n.value !== "string" || b.value === n.value) return;

    if (!b.map) return;
    let map: Mapping | null = null;
    if (/smartypants/i.test(stage)) map = typography(b.value, n.value, b.map);
    else if (
      stage.startsWith("html:LinkProcessing") &&
      b.value.endsWith(n.value)
    )
      map = b.map.slice(b.value.length - n.value.length);
    else if (
      stage.startsWith("html:ObsidianFlavoredMarkdown") &&
      b.value.startsWith(n.value)
    )
      map = b.map.slice(0, n.value.length);
    else map = alignOmissions({ text: b.value, map: b.map }, n.value);
    n._prov = map ?? Array(n.value.length).fill(null);
  });
}
function fillCode(tree: any) {
  walk(tree, (n, a) => {
    if (n.type !== "text" || n._prov) return;
    const p = [...a].reverse().find((p) => p._codeProv);
    if (p) {
      const raw = p._codeValue;
      const m = p._codeProv;
      n._prov =
        n.value === raw + "\n"
          ? [...m, null]
          : n.value === raw
            ? m.slice()
            : undefined;
    }
  });
}
function syntaxRecover(before: any, tree: any) {
  const oldPres: any[] = [];
  walk(before, (n) => {
    if (n.tagName === "pre") oldPres.push(n);
  });
  const pres: any[] = [];
  walk(tree, (n) => {
    if (n.tagName === "pre") pres.push(n);
  });
  for (let i = 0; i < Math.min(oldPres.length, pres.length); i++) {
    const oldTexts: any[] = [];
    walk(oldPres[i], (n) => {
      if (n.type === "text") oldTexts.push(n);
    });
    let input = oldTexts.map((n) => n.value).join("");
    let m = oldTexts.flatMap(
      (n) => n._prov ?? Array(n.value.length).fill(null),
    );
    const texts: any[] = [];
    walk(pres[i], (n) => {
      if (n.type === "text") texts.push(n);
    });
    const output = texts.map((n) => n.value).join("");
    // Highlighting normalizes CRLF before splitting token lines.
    const normalized = { text: "", map: [] as Mapping };
    for (let j = 0; j < input.length; ) {
      if (input[j] === "\r") {
        const len = input[j + 1] === "\n" ? 2 : 1;
        emit(normalized, "\n", joinSpan(m.slice(j, j + len), "line-ending"));
        j += len;
      } else {
        normalized.text += input[j];
        normalized.map.push(m[j] ?? null);
        j++;
      }
    }
    input = normalized.text;
    m = normalized.map;
    if (input.endsWith("\n") && !output.endsWith("\n")) {
      input = input.slice(0, -1);
      m = m.slice(0, -1);
    }
    let map = alignOmissions({ text: input, map: m }, output);
    // Pretty-code inserts one space in otherwise-empty highlighted lines. Match lines at the same line index, never by global substring.
    if (!map) {
      const ins = input.split("\n"),
        outs = output.split("\n");
      if (ins.length === outs.length) {
        map = [];
        let p = 0;
        for (let z = 0; z < ins.length; z++) {
          if (ins[z] === outs[z]) map.push(...m.slice(p, p + ins[z].length));
          else if (ins[z] === "" && /^ +$/.test(outs[z]))
            map.push(...Array(outs[z].length).fill(null));
          else {
            map = null;
            break;
          }
          p += ins[z].length;
          if (z < ins.length - 1) {
            map.push(m[p] ?? null);
            p++;
          }
        }
      }
    }
    if (map) {
      let p = 0;
      for (const n of texts) {
        n._prov = map.slice(p, p + n.value.length);
        p += n.value.length;
      }
    }
  }
}
function makeVirtual(tree: any) {
  let text = "";
  const map: Mapping = [];
  const positions = new Map<any, any>();
  const kinds: { s: number; e: number; kind: string }[] = [];
  const blocks: { s: number; e: number; tag: string; block: any }[] = [];
  const authoredHtml: { s: number; e: number }[] = [];
  const add = (s: string, m?: Mapping) => {
    text += s;
    map.push(...(m ?? Array(s.length).fill(null)));
  };
  const point = (offset: number) => ({ line: 1, column: offset + 1, offset });
  const write = (n: any) => {
    positions.set(n, n.position);
    const start = text.length;
    if (n.type === "text") {
      for (let i = 0; i < n.value.length; ) {
        const c = String.fromCodePoint(n.value.codePointAt(i));
        const escaped =
          c === "&"
            ? "&amp;"
            : c === "<"
              ? "&lt;"
              : c === ">"
                ? "&gt;"
                : c === "\r"
                  ? "&#13;"
                  : c === "\n"
                    ? "&#10;"
                    : c;
        const sp = n._prov?.[i] ?? null;
        add(escaped, Array(escaped.length).fill(sp));
        i += c.length;
      }
    } else if (n.type === "raw") add(n.value, n._prov);
    else if (n.type === "element") {
      const serialized = toHtml(
        { ...n, children: [] },
        { allowDangerousHtml: true },
      );
      const end = serialized.indexOf(">") + 1;
      add(serialized.slice(0, end));
      for (const c of n.children ?? []) write(c);
      add(serialized.slice(end));
    } else if (n.type === "root") for (const c of n.children ?? []) write(c);
    else if (n.type === "comment") add("<!--" + n.value + "-->");
    n.position = { start: point(start), end: point(text.length) };
    if (n._kind) kinds.push({ s: start, e: text.length, kind: n._kind });
    if (n._cbBlock)
      blocks.push({
        s: start,
        e: text.length,
        tag: n.tagName,
        block: n._cbBlock,
      });
    if (n.type === "raw" && !n._kind && n._prov?.some(Boolean))
      authoredHtml.push({ s: start, e: text.length });
  };
  write(tree);
  return { text, map, positions, kinds, blocks, authoredHtml };
}
function finishVirtual(tree: any, v: any) {
  walk(tree, (n) => {
    if (n.type === "element") {
      const s = n.position?.start?.offset,
        e = n.position?.end?.offset;
      if (v.authoredHtml.some((r: any) => r.s <= s && s < r.e))
        n._cbRawHtml = true;
      const block = v.blocks.find(
        (b: any) => b.s === s && b.e === e && b.tag === n.tagName,
      );
      if (block) n._cbBlock = block.block;
      // A standalone OFM transclusion is emitted as raw blockquote inside a
      // paragraph. HTML parsing closes that paragraph. Its enclosing source
      // block can still identify the transclusion, but NEVER expose its text.
      if (
        !block &&
        n.tagName === "blockquote" &&
        String(n.properties?.className ?? "")
          .split(/[ ,]+/)
          .includes("transclude")
      ) {
        const owners = v.blocks.filter(
          (b: any) => b.s <= s && b.e >= e && b.block.reason === "transclusion",
        );
        if (owners.length === 1) n._cbBlock = owners[0].block;
      }
    }
    if (n.type !== "text") return;
    const s = n.position?.start?.offset,
      e = n.position?.end?.offset;
    if (
      Number.isInteger(s) &&
      Number.isInteger(e) &&
      s >= 0 &&
      e <= v.text.length
    ) {
      const d = lexical(v.text.slice(s, e), v.map.slice(s, e), true);
      n._prov =
        d.text === n.value
          ? d.map
          : (alignOmissions(d, n.value) ?? Array(n.value.length).fill(null));
      const k = v.kinds.find((x: any) => x.s <= s && x.e >= e);
      if (k) n._kind = k.kind;
    } else n._prov = Array(n.value.length).fill(null);
    delete n.position; // These were virtual instrumentation offsets, never original-source positions.
  });
}
/** Record the first provenance failure for one note; later steps skip it. */
function markProvenanceFailed(state: any, step: string, error: unknown) {
  if (!state || state.failed) return;
  const message = error instanceof Error ? error.message : String(error);
  state.failed = { step, error: message.split("\n", 1)[0].slice(0, 200) };
}
function wrap(plugin: any, stage: string): any {
  const attacher = Array.isArray(plugin) ? plugin[0] : plugin;
  const options = Array.isArray(plugin) ? plugin.slice(1) : [];
  const name = attacher.name || "anonymous";
  const wrapper = function (this: any) {
    const transform = attacher.apply(this, options);
    if (typeof transform !== "function") return transform;
    return async (tree: any, file: any) => {
      // Provenance is best-effort per note: once a note's tracking fails, its
      // plugins run untracked and the note is emitted without a sidecar.
      const state = file?.data?.sourceProvenance;
      if (state?.failed) return transform(tree, file);
      let before: Map<any, any>, syntax: any, virtual: any, restoreBlocks: any;
      try {
        if (stage === "html:SyntaxHighlighting") fillCode(tree);
        before = new Map<any, any>();
        walk(tree, (n) => {
          if (typeof n.value === "string")
            before.set(n, { value: n.value, map: n._prov?.slice() });
        });
        syntax =
          stage === "html:SyntaxHighlighting" ? structuredClone(tree) : null;
        virtual =
          stage === "html:ObsidianFlavoredMarkdown" && name === "rehypeRaw"
            ? makeVirtual(tree)
            : null;
        restoreBlocks =
          stage === "html:Latex" ? blockReplacementSnapshot(tree) : undefined;
      } catch (error) {
        markProvenanceFailed(state, `${stage}:${name}`, error);
        return transform(tree, file);
      }
      const result = await transform(tree, file);
      try {
        const next = result ?? tree;
        if (next === tree) restoreBlocks?.();
        if (virtual) {
          finishVirtual(next, virtual);
          for (const [n, p] of virtual.positions) n.position = p;
        } else syncMutation(before, next, stage + ":" + name);
        if (syntax) syntaxRecover(syntax, next);
      } catch (error) {
        markProvenanceFailed(state, `${stage}:${name}`, error);
      }
      return result;
    };
  };
  return wrapper;
}

export {
  originalMap,
  rewriteMap,
  annotateInitial,
  markProvenanceFailed,
  wrap,
  walk,
  joinSpan,
  lexical,
  typography,
  alignOmissions,
};
