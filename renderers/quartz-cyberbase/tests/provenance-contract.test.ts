import assert from "node:assert/strict";
import {
  emitProvenance,
  type ProvenanceSink,
  type ProvenanceBlock,
  MAX_PROVENANCE_BLOCK_BYTES,
  MAX_PROVENANCE_SIDECAR_BYTES,
} from "../plugins/provenanceContract";
import {
  captureSourceBlocks,
  renderedSourceBlocks,
  blockReplacementSnapshot,
} from "../plugins/provenanceBlocks";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const calls: unknown[] = [];
const sink: ProvenanceSink = {
  write: (page, manifest) => {
    calls.push([page, manifest]);
  },
};
const source = {
  path: "notes/example.md",
  byteLength: 9,
  sha256: "a".repeat(64),
};
const leaves = [
  {
    id: "cb0.0",
    parent: "cb0",
    child: 0,
    text: "😀",
    runs: [
      {
        rendered: [0, 2] as [number, number],
        source: [2, 6] as [number, number],
        kind: "exact" as const,
      },
    ],
    exact: [2, 6] as [number, number],
  },
];
const manifest = emitProvenance(sink, "notes/example", source, leaves);
assert.equal(manifest.schema, "cyberbaser.source-provenance");
assert.equal(manifest.version, 2);
assert.deepEqual(calls, [
  [
    "notes/example",
    {
      schema: "cyberbaser.source-provenance",
      version: 2,
      source,
      leaves,
      blocks: [],
    },
  ],
]);
assert.deepEqual(JSON.parse(JSON.stringify(manifest)), manifest);

// The neutral emitter enforces privacy/size even for another renderer's sink.
const safeBlock: ProvenanceBlock = {
  id: "block0",
  parent: "cb0",
  source: [2, 6],
  editable: true,
  text: "😀",
};
assert.deepEqual(
  emitProvenance(sink, "example", source, leaves, [safeBlock]).blocks,
  [safeBlock],
);
const oversized: ProvenanceBlock = {
  ...safeBlock,
  text: "😀".repeat(MAX_PROVENANCE_BLOCK_BYTES / 4 + 1),
};
const large = emitProvenance(sink, "example", source, [], [oversized]);
assert.equal(large.blocks[0].editable, false);
assert.equal(large.blocks[0].reason, "too-large");
assert.ok(!("text" in large.blocks[0]));
const unsafe = {
  ...safeBlock,
  editable: false,
  reason: "raw-html",
  text: "hidden",
} as unknown as ProvenanceBlock;
assert.ok(
  !("text" in emitProvenance(sink, "example", source, [], [unsafe]).blocks[0]),
);
const hugeLeaf = {
  ...leaves[0],
  text: "x".repeat(MAX_PROVENANCE_SIDECAR_BYTES),
};
const bounded = emitProvenance(
  sink,
  "example",
  source,
  [hugeLeaf],
  [safeBlock],
);
assert.deepEqual(bounded.leaves, []);
assert.equal(bounded.blocks[0].reason, "too-large");
assert.ok(
  Buffer.byteLength(JSON.stringify(bounded) + "\n") <=
    MAX_PROVENANCE_SIDECAR_BYTES,
);
// Source payload alone can exhaust the aggregate budget; leaves remain usable.
const manyBlocks = Array.from({ length: 600 }, (_, i) => ({
  ...safeBlock,
  id: `block${i}`,
  text: "x".repeat(8192),
}));
const aggregate = emitProvenance(sink, "example", source, leaves, manyBlocks);
assert.equal(aggregate.blocks.filter((b) => b.editable).length, 0);
assert.deepEqual(aggregate.leaves, leaves);

// Pure block classifier fixtures: original positions are retained even when OFM
// removes a comment at the beginning/end/middle of a paragraph before parsing.
function parsedParagraph(text: string, type = "paragraph", children?: any[]) {
  return {
    type,
    position: { start: { offset: 0 }, end: { offset: text.length } },
    children: children ?? [{ type: "text", value: text }],
  };
}
const identity = (text: string) => {
  const map: { s: number; e: number }[] = [];
  let i = 0;
  for (const c of text) {
    const sp = { s: i, e: i + c.length };
    for (const _ of c.split("")) map.push(sp);
    i += c.length;
  }
  return map;
};
for (const text of [
  "before %%hidden%% after",
  "%%hidden%% before",
  "after %%hidden%%",
  "before <!--hidden--> after",
  "![[other]]",
]) {
  const original = parsedParagraph(text);
  const clean = text.replace(/%%[\s\S]*?%%/g, "");
  const mapping = identity(text);
  const removed = [...text.matchAll(/%%[\s\S]*?%%/g)].map((m) => [
    m.index!,
    m.index! + m[0].length,
  ]);
  const map = mapping.filter(
    (_, i) => !removed.some(([s, e]) => i >= s && i < e),
  );
  const transformed = parsedParagraph(clean);
  const records = captureSourceBlocks(
    text,
    original,
    mapping,
    transformed,
    map,
    "a.md",
  );
  assert.equal(records.length, 1);
  const tree = {
    type: "element",
    tagName: "p",
    properties: {},
    _cbBlock: records[0],
  };
  const [block] = renderedSourceBlocks(tree, text, "a.md");
  assert.equal(block.editable, false, text);
  assert.ok(!("text" in block), text);
  assert.deepEqual(block.source, [0, Buffer.byteLength(text)]);
}
const exactText = "Emoji 😀\r\nnext";
const original = parsedParagraph(exactText);
const transformed = parsedParagraph(exactText);
const [record] = captureSourceBlocks(
  exactText,
  original,
  identity(exactText),
  transformed,
  identity(exactText),
  "a.md",
);
const element = {
  type: "element",
  tagName: "p",
  properties: {},
  _cbBlock: record,
};
assert.equal(
  renderedSourceBlocks(element, exactText, "a.md")[0].text,
  exactText,
);
assert.deepEqual(renderedSourceBlocks(element, exactText, "foreign.md"), []);
assert.deepEqual(
  renderedSourceBlocks(
    { children: [element, { ...element }] },
    exactText,
    "a.md",
  ),
  [],
);
assert.deepEqual(
  renderedSourceBlocks(
    { properties: { className: ["transclude"] }, children: [element] },
    exactText,
    "a.md",
  ),
  [],
);
const mathElement = {
  ...element,
  tagName: "pre",
  children: [
    {
      type: "element",
      tagName: "code",
      properties: { className: ["language-math", "math-display"] },
    },
  ],
};
const replacementTree = { children: [mathElement] };
const restore = blockReplacementSnapshot(replacementTree);
replacementTree.children = [
  {
    type: "element",
    tagName: "span",
    properties: { className: ["katex-display"] },
  } as any,
];
restore();
assert.equal((replacementTree.children[0] as any)._cbBlock, record);
console.log(
  "PASS v2 block contract: exact UTF-8/CRLF, hidden-source omission, cross-source/duplicate guards, 8 KiB block and 4 MiB sidecar caps",
);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "provenance-guard-"));
const helper = path.resolve(import.meta.dir, "../patches/apply-provenance.mjs");
try {
  // Invalid input cannot silently opt in, even without any target files.
  assert.throws(
    () =>
      execFileSync("node", [helper, temp], {
        env: { ...process.env, CYBERBASER_SOURCE_PROVENANCE: "true" },
        stdio: "pipe",
      }),
    /must be 'enabled' or 'disabled'/,
  );
  const target = path.join(temp, "quartz/plugins/types.ts");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "not the pinned upstream file");
  assert.throws(
    () =>
      execFileSync("node", [helper, temp], {
        env: {
          ...process.env,
          CYBERBASER_SOURCE_PROVENANCE: "enabled",
          QUARTZ_SEED_DIR: "",
        },
        stdio: "pipe",
      }),
    /SHA-256 mismatch/,
  );
  assert.equal(fs.readFileSync(target, "utf8"), "not the pinned upstream file");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(
  "source-provenance contract, injectable sink, invalid-mode and pristine-hash guard checks passed",
);
