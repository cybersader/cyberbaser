#!/usr/bin/env node
// Real Quartz CLI acceptance, not the research parser. Run inside build-contained.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const renderer = path.join(repo, "renderers/quartz-cyberbase");
const seed =
  process.env.QUARTZ_SEED_DIR ??
  path.join(repo, ".workspace/suggestions-rehearsal-renderer");
const corpus = process.argv.includes("--corpus");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cyberbaser-provenance-"));
const quartz = path.join(temp, "quartz"),
  input = path.join(temp, "input"),
  output = path.join(temp, "output");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const env = {
  ...process.env,
  QUARTZ_OFFLINE: "1",
  QUARTZ_SEED_DIR: seed,
  CYBERBASER_SOURCE_PROVENANCE: "disabled",
  CYBERBASER_EDIT_LINK_MODE: "public",
  TZ: "UTC",
};
delete env.CYBERBASER_ACCOUNT_FREE_INTAKE;
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, {
    cwd: repo,
    env,
    stdio: "pipe",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
const files = (directory) =>
  fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((f) =>
      f.isDirectory()
        ? files(path.join(directory, f.name))
        : [path.join(directory, f.name)],
    );
const list = (directory) =>
  Object.fromEntries(
    files(directory)
      .sort()
      .map((file) => [
        path.relative(directory, file),
        hash(fs.readFileSync(file)),
      ]),
  );
const fixture =
  "  \r\n---\r\ntitle: Provenance fixture\r\ndate: 2020-01-01\r\n---\r\n# Heading 😀\r\n\r\nUnique roundtrip prose.\r\n\r\nEmoji 😀🧪, entity &amp;, escape \\*, smart \"quotes\" -- ... .\r\n\r\nBefore [[target|named alias]] between [[target]] after.\r\n\r\n> [!note] Custom title\r\n> Callout body **bold**.\r\n\r\n| A | B |\r\n| --- | --- |\r\n| cell | escaped \\| pipe |\r\n\r\nInline <span>HTML &amp; 😀</span> tail.\r\n\r\nCode `a\r\nb` and `entity &amp; literal`.\r\n\r\n```js\r\nconst emoji = '😀';\r\n\r\nconsole.log(emoji);\r\n```\r\n\r\n- list first\r\n  continuation\r\n\r\n> quoted\r\n> continuation\r\n\r\nMath $x^2$.\r\n\r\n![[target]]\r\n\r\n%% private omitted comment %%\r\n";
const hermetic =
  '\n// Test-only: no font downloads/social-image generation; all source transformers unchanged.\nconfig.configuration.theme.fontOrigin = "local"\nconfig.configuration.theme.cdnCaching = false\nconfig.plugins.emitters = config.plugins.emitters.filter((p) => p.name !== "CustomOgImages")\n';
function config(text) {
  fs.writeFileSync(path.join(quartz, "quartz.config.ts"), text + hermetic);
}
function build(mode, concurrency = 1) {
  env.CYBERBASER_SOURCE_PROVENANCE = mode;
  run("node", [path.join(renderer, "patches/apply-provenance.mjs"), quartz]);
  fs.rmSync(output, { recursive: true, force: true });
  const log = run(
    "node",
    [
      path.join(quartz, "quartz/bootstrap-cli.mjs"),
      "build",
      "-d",
      input,
      "-o",
      output,
      "--concurrency",
      String(concurrency),
    ],
    { cwd: quartz },
  );
  fs.writeFileSync(path.join(temp, `build-${mode}-${concurrency}.log`), log);
}
try {
  fs.mkdirSync(input);
  if (corpus) {
    // The only permitted access to the real vault (read-only git archive of a
    // published folder). The vault path comes from the environment, never the repo.
    const vault = process.env.CYBERBASER_CORPUS_VAULT
    if (!vault) throw new Error("Set CYBERBASER_CORPUS_VAULT to a local vault checkout to run the corpus check")
    const archive = run("git", [
      "-C",
      vault,
      "archive",
      "origin/main",
      "--",
      "📁 03 - Curations, Stacks",
    ]);
    run("tar", ["-x", "-C", input], { input: archive });
    assert.equal(files(input).filter((p) => p.endsWith(".md")).length, 57);
  } else {
    fs.writeFileSync(path.join(input, "index.md"), fixture);
    fs.writeFileSync(
      path.join(input, "target.md"),
      "---\ntitle: Target\ndate: 2020-01-01\n---\n# Target\n\nForeign source prose.\n",
    );
    fs.writeFileSync(path.join(input, "empty.md"), "---\ntitle: Empty\n---\n");
  }
  // Stable filesystem date fallback, including empty/no-frontmatter pages.
  for (const file of files(input))
    fs.utimesSync(file, new Date("2020-01-01"), new Date("2020-01-01"));
  run("bash", [path.join(renderer, "setup.sh"), quartz]);
  const currentConfig = fs.readFileSync(
    path.join(renderer, "quartz.config.ts"),
    "utf8",
  );
  if (!corpus) {
    const baseline = currentConfig
      .replace(/^import \{ provenanceMode, withSourceProvenance \}.*\n/m, "")
      .replace(
        /if \(provenanceMode\(process\.env\.CYBERBASER_SOURCE_PROVENANCE\)\) \{\n  config\.plugins\.transformers = withSourceProvenance\(config\.plugins\.transformers\)\n\}\n\n/,
        "",
      );
    config(baseline);
    build("disabled");
    const golden = list(output);
    config(currentConfig);
    build("disabled");
    assert.deepEqual(
      list(output),
      golden,
      "disabled output differs from uninstrumented golden",
    );
    assert.equal(
      files(output).some((f) => f.endsWith(".provenance.json")),
      false,
    );
    console.log(
      `PASS disabled golden: ${Object.keys(golden).length} emitted files byte-identical`,
    );
  } else config(currentConfig);
  build("enabled");
  const parse5 = await import(
    pathToFileURL(path.join(quartz, "node_modules/parse5/dist/index.js"))
  );
  function walk(node, callback, ancestors = []) {
    callback(node, ancestors);
    for (const child of node.childNodes ?? [])
      walk(child, callback, [...ancestors, node]);
  }
  const attr = (node, name) => node.attrs?.find((a) => a.name === name)?.value;
  function check() {
    let chars = 0,
      mapped = 0,
      exact = 0,
      atoms = 0,
      verifiedLeaves = 0,
      rawChars = 0,
      rawMapped = 0;
    const reasons = {},
      manifests = new Map(),
      bodies = new Map();
    const sidecars = files(output).filter((p) =>
      p.endsWith(".provenance.json"),
    );
    for (const file of sidecars) {
      const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(manifest.schema, "cyberbaser.source-provenance");
      assert.equal(manifest.version, 1);
      const raw = fs.readFileSync(path.join(input, manifest.source.path));
      assert.equal(manifest.source.sha256, hash(raw));
      assert.equal(manifest.source.byteLength, raw.length);
      const html = file.replace(/\.provenance\.json$/, ".html");
      assert.ok(fs.existsSync(html), `sidecar has no emitted page: ${file}`);
      const document = parse5.parse(fs.readFileSync(html, "utf8"));
      const elements = new Map(),
        parents = new Map();
      let body;
      walk(document, (node, ancestors) => {
        if (
          node.tagName === "article" &&
          (attr(node, "class") ?? "").split(" ").includes("popover-hint")
        )
          body = node;
        parents.set(node, ancestors);
      });
      assert.ok(body, `source body missing in ${html}`);
      walk(body, (node) => {
        const id = attr(node, "data-cb-node");
        if (id) {
          assert.ok(!elements.has(id), `duplicate ${id}`);
          elements.set(id, node);
        }
      });
      elements.set("$body", body);
      const claimed = new Set();
      for (const leaf of manifest.leaves) {
        const parent = elements.get(leaf.parent);
        const text = parent?.childNodes[leaf.child];
        assert.equal(
          text?.nodeName,
          "#text",
          `locator missing: ${manifest.source.path} ${leaf.id}`,
        );
        assert.equal(
          text.value,
          leaf.text,
          `text differs: ${manifest.source.path} ${leaf.id}`,
        );
        assert.ok(!claimed.has(text));
        claimed.add(text);
        const preserve = parents.get(text).some((n) => n.tagName === "pre");
        let pos = 0;
        const scalar = [];
        for (const run of leaf.runs) {
          assert.equal(run.rendered[0], pos);
          assert.ok(run.rendered[1] > pos);
          const value = leaf.text.slice(...run.rendered);
          if (run.source) {
            const [start, end] = run.source;
            assert.ok(start >= 0 && end > start && end <= raw.length);
            const source = new TextDecoder("utf-8", { fatal: true }).decode(
              raw.subarray(start, end),
            );
            if (run.kind === "exact") assert.equal(source, value);
            else assert.equal(run.kind, "atom");
          } else assert.ok(run.reason);
          for (const char of value)
            scalar.push({ char, kind: run.kind, reason: run.reason });
          pos = run.rendered[1];
        }
        assert.equal(pos, leaf.text.length);
        rawChars += scalar.length;
        rawMapped += scalar.filter((x) => x.kind).length;
        if (leaf.exact) {
          assert.equal(raw.subarray(...leaf.exact).toString("utf8"), leaf.text);
          verifiedLeaves++;
        }
        // Match historical denominator: substantive leaves, HTML ASCII whitespace collapsed outside pre.
        if (!/\S/.test(leaf.text)) continue;
        const normalized = [];
        for (let i = 0; i < scalar.length; i++) {
          if (!preserve && /[\t\n\r\f ]/.test(scalar[i].char)) {
            let j = i + 1;
            while (j < scalar.length && /[\t\n\r\f ]/.test(scalar[j].char)) j++;
            normalized.push({
              char: " ",
              kind: scalar.slice(i, j).every((x) => x.kind)
                ? scalar[i].kind
                : undefined,
              reason: scalar.slice(i, j).every((x) => x.reason === scalar[i].reason)
                ? scalar[i].reason
                : "generated-whitespace",
            });
            i = j - 1;
          } else normalized.push(scalar[i]);
        }
        for (const s of normalized) {
          chars++;
          if (s.kind) {
            mapped++;
            if (s.kind === "exact") exact++;
            else atoms++;
          } else reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
        }
      }
      // Every final source-body text leaf is represented, including generated/transcluded leaves.
      walk(body, (node) => {
        if (node.nodeName === "#text")
          assert.ok(
            claimed.has(node),
            `unrecorded body text: ${node.value.slice(0, 80)}`,
          );
      });
      manifests.set(manifest.source.path, manifest);
      let bodyText = "";
      walk(body, (node) => {
        if (node.nodeName === "#text") bodyText += node.value;
      });
      bodies.set(manifest.source.path, bodyText);
    }
    console.log(
      `PASS ${corpus ? "corpus" : "fixtures"}: ${sidecars.length} pages; ${mapped}/${chars} substantive characters mapped (${((100 * mapped) / chars).toFixed(4)}%); exact=${exact}, atoms=${atoms}; ${verifiedLeaves} exact whole-leaf byte checks`,
    );
    console.log(
      `raw coverage: ${rawMapped}/${rawChars}; unmapped=${JSON.stringify(reasons)}`,
    );
    return { manifests, bodies, sidecars, mapped, chars };
  }
  const first = check();
  if (corpus) {
    assert.equal(first.sidecars.length, 57);
    assert.ok(first.mapped / first.chars > 0.98);
  } else {
    const fixtureManifest = first.manifests.get("index.md");
    const flattened = fixtureManifest.leaves.flatMap((l) =>
      l.runs.map((r) => ({ ...r, text: l.text.slice(...r.rendered) })),
    );
    for (const reason of [
      "target-derived-wikilink",
      "callout-title",
      "math",
      "transclusion",
    ])
      assert.ok(
        flattened.some((r) => r.reason === reason),
        reason,
      );
    for (const expected of [
      "named alias",
      "😀",
      "cell",
      "HTML",
      "console.",
      "log",
    ])
      assert.ok(
        flattened.some((r) => r.source && r.text.includes(expected)),
        expected,
      );
    assert.ok(flattened.some((r) => r.kind === "atom" && r.text === "&"));
    assert.ok(flattened.some((r) => r.kind === "atom" && r.text === "*"));
    console.log(
      "PASS emoji, CRLF, entities, escapes, aliases/targets, callout, table, inline HTML, code, math and transclusion fixtures",
    );
    // Same source bytes and output through two actual Quartz worker threads.
    const single = new Map(
      [...first.manifests].map(([key, value]) => [key, JSON.stringify(value)]),
    );
    build("enabled", 2);
    const worker = check();
    assert.deepEqual(
      new Map(
        [...worker.manifests].map(([key, value]) => [
          key,
          JSON.stringify(value),
        ]),
      ),
      single,
    );
    console.log("PASS worker provenance equals single-thread provenance");
    const leaf = fixtureManifest.leaves.find(
      (l) => l.exact && l.text.includes("Unique roundtrip prose."),
    );
    assert.ok(leaf);
    const raw = fs.readFileSync(path.join(input, "index.md")),
      [start, end] = leaf.exact;
    const replacement = leaf.text.replace(
      "Unique roundtrip prose.",
      "Changed roundtrip prose.",
    );
    fs.writeFileSync(
      path.join(input, "index.md"),
      Buffer.concat([
        raw.subarray(0, start),
        Buffer.from(replacement),
        raw.subarray(end),
      ]),
    );
    fs.utimesSync(
      path.join(input, "index.md"),
      new Date("2020-01-01"),
      new Date("2020-01-01"),
    );
    build("enabled");
    const after = check();
    assert.equal(
      after.bodies.get("index.md"),
      first.bodies
        .get("index.md")
        .replace("Unique roundtrip prose.", "Changed roundtrip prose."),
    );
    assert.equal(after.bodies.get("target.md"), first.bodies.get("target.md"));
    console.log(
      "PASS exact-byte splice round trip: rebuilt body changes only the declared prose",
    );
    const altered = path.join(quartz, "quartz/processors/parse.ts");
    fs.appendFileSync(altered, "\n// simulated upstream drift\n");
    assert.throws(
      () =>
        run("node", [
          path.join(renderer, "patches/apply-provenance.mjs"),
          quartz,
        ]),
      /SHA-256 mismatch/,
    );
    console.log("PASS upstream hash drift fails closed");
  }
  fs.rmSync(temp, { recursive: true, force: true });
} catch (error) {
  console.error(error.stderr?.toString() ?? error.stack);
  console.error(
    `Provenance acceptance failed; isolated artifacts retained at ${temp}`,
  );
  process.exitCode = 1;
}
