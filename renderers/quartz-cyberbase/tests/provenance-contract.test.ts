import assert from "node:assert/strict";
import {
  emitProvenance,
  type ProvenanceSink,
} from "../plugins/provenanceContract";
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
assert.equal(manifest.version, 1);
assert.deepEqual(calls, [
  [
    "notes/example",
    { schema: "cyberbaser.source-provenance", version: 1, source, leaves },
  ],
]);
assert.deepEqual(JSON.parse(JSON.stringify(manifest)), manifest);

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
