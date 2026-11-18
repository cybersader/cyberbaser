// @ts-nocheck
// Position-aware counterpart of the pinned OFM textTransform, not a parser.
// Every call is checked against the actual transformer output before its map is used.
import { originalMap, rewriteMap } from "./provenanceCore";
import {
  wikilinkRegex,
  tableRegex,
  tableWikilinkRegex,
  externalLinkRegex,
} from "../plugins/transformers/ofm";
import { splitAnchor } from "../util/path";

type Tracked = { text: string; map: any[] };
function replace(
  input: Tracked,
  pattern: RegExp | string,
  callback: (hit: Tracked, match: any[]) => Tracked,
): Tracked {
  const regex =
    typeof pattern === "string"
      ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      : new RegExp(pattern.source, pattern.flags);
  let cursor = 0;
  let text = "";
  const map: any[] = [];
  for (let match; (match = regex.exec(input.text)); ) {
    const offset = match.index;
    const hit = callback(
      {
        text: match[0],
        map: input.map.slice(offset, offset + match[0].length),
      },
      match,
    );
    text += input.text.slice(cursor, offset) + hit.text;
    map.push(...input.map.slice(cursor, offset), ...hit.map);
    cursor = offset + match[0].length;
    if (!regex.global) break;
    if (match[0].length === 0) regex.lastIndex++;
  }
  return {
    text: text + input.text.slice(cursor),
    map: [...map, ...input.map.slice(cursor)],
  };
}
const rewrite = (hit: Tracked, text: string): Tracked => ({
  text,
  map: rewriteMap(hit.text, text, hit.map),
});
export function trimmedSource(raw: string): Tracked {
  const start = raw.length - raw.trimStart().length;
  return {
    text: raw.trim(),
    map: originalMap(raw).slice(start, raw.trimEnd().length),
  };
}
export function mapOfm(input: Tracked): Tracked {
  let out = replace(input, /%%[\s\S]*?%%/g, () => ({ text: "", map: [] }));
  out = replace(out, /^> *\[!\w+\|?.*?\][+-]?.*$/gm, (hit) => ({
    text: hit.text + "\n> ",
    map: [...hit.map, null, null, null],
  }));
  out = replace(out, tableRegex, (table) =>
    replace(table, tableWikilinkRegex, (hit) => {
      let escaped = replace(hit, "#", (part) => rewrite(part, "\\#"));
      escaped = replace(escaped, /((^|[^\\])(\\\\)*)\|/g, (part, match) =>
        rewrite(part, match[1] + "\\|"),
      );
      return escaped;
    }),
  );
  return replace(out, wikilinkRegex, (hit, match) => {
    const [, rawFp, rawHeader, rawAlias] = match;
    const [fp, anchor] = splitAnchor(`${rawFp ?? ""}${rawHeader ?? ""}`);
    const blockRef = Boolean(rawHeader?.startsWith("#^")) ? "^" : "";
    const displayAnchor = anchor
      ? `#${blockRef}${anchor.trim().replace(/^#+/, "")}`
      : "";
    const displayAlias = rawAlias ?? rawHeader?.replace("#", "|") ?? "";
    const embedDisplay = hit.text.startsWith("!") ? "!" : "";
    const text = rawFp?.match(externalLinkRegex)
      ? `${embedDisplay}[${displayAlias.replace(/^\|/, "")}](${rawFp})`
      : `${embedDisplay}[[${fp}${displayAnchor}${displayAlias}]]`;
    return rewrite(hit, text);
  });
}
