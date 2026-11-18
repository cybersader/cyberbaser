#!/usr/bin/env node
// Fail closed before touching any upstream file. Never patches dependencies.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const mode = process.env.CYBERBASER_SOURCE_PROVENANCE ?? "disabled";
try {
  if (!["enabled", "disabled"].includes(mode))
    throw Error("CYBERBASER_SOURCE_PROVENANCE must be 'enabled' or 'disabled'");
  if (!process.argv[2])
    throw Error("expected one materialized Quartz checkout");
  const root = fs.realpathSync(process.argv[2]);
  if (
    process.env.QUARTZ_SEED_DIR &&
    fs.realpathSync(process.env.QUARTZ_SEED_DIR) === root
  ) {
    throw Error("refusing to modify the read-only Quartz seed");
  }
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(here, "quartz-4.5.2-provenance.sha256.json"),
      "utf8",
    ),
  );
  const sha = (file) =>
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const states = Object.entries(manifest.files).map(([relative, hashes]) => {
    const file = path.join(root, relative);
    if (fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== file)
      throw Error(`substituted patch target: ${relative}`);
    const actual = sha(file);
    if (actual === hashes.pristine) return "pristine";
    if (actual === hashes.enabled) return "enabled";
    throw Error(
      `source provenance SHA-256 mismatch for ${relative}: expected pristine ${hashes.pristine}, got ${actual}; re-materialize the pinned checkout`,
    );
  });
  if (!states.every((state) => state === states[0]))
    throw Error(
      "mixed pristine/patched Quartz files; re-materialize the pinned checkout",
    );
  if (mode === "disabled") {
    if (states[0] !== "pristine")
      throw Error(
        "source provenance is disabled but this checkout is patched; run setup.sh with a pristine seed first",
      );
    process.exit(0);
  }
  if (states[0] === "pristine") {
    execFileSync(
      "patch",
      [
        "--batch",
        "--forward",
        "--fuzz=0",
        "-p1",
        "--directory",
        root,
        "--input",
        path.join(here, "quartz-4.5.2-provenance.patch"),
      ],
      { stdio: "inherit" },
    );
  }
  for (const [relative, hashes] of Object.entries(manifest.files)) {
    if (sha(path.join(root, relative)) !== hashes.enabled)
      throw Error(`post-patch SHA-256 mismatch for ${relative}`);
  }
  console.log("==> source provenance: verified Quartz 4.5.2 adapter patch");
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(2);
}
