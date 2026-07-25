import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { select } from '@cyberbaser/publish';
import {
  project,
  verifyProjection,
  preflightFrontmatter,
  findCaseCollisions,
  injectAlias,
  projectedPath,
} from '../src/index.js';

// -------------------------------------------------------------------- fixtures

const roots = [];

function mkroot(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cb-projection-${name}-`));
  roots.push(dir);
  return dir;
}

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const BAD_FRONTMATTER = ['---', 'title: "never closed', 'tags: [a, b', '---', '', 'body'].join('\n');

/**
 * One vault covering the whole matrix: a case-changing page, an already-lowercase page, a
 * page with existing aliases, a page with no frontmatter, an unpublished page with broken
 * YAML (must not block), a denied page whose title is referenced from a published page,
 * a URL in a tags array, and a binary asset.
 */
function makeVault() {
  const v = mkroot('vault');
  write(v, 'publish.yml', 'allow:\n  - pub\n');

  write(
    v,
    'pub/Alpha Note.md',
    ['---', 'title: Alpha', 'tags:', '  - "https://example.com/ref"', '---', '', '# Alpha', '', 'Links to [[Secret Plans]] and embeds ![[Logo.PNG]].', 'Trailing unicode: café ☕', ''].join('\n'),
  );
  write(v, 'pub/lower.md', ['---', 'title: Lower', '---', '', '# Lower', ''].join('\n'));
  write(
    v,
    'pub/Has Aliases.md',
    ['---', 'title: Has Aliases', 'aliases:', '  - Old Name', '  - another/one', 'draft: false', '---', '', '# Has Aliases', ''].join('\n'),
  );
  write(v, 'pub/No Frontmatter.md', ['# No Frontmatter', '', 'Just a body.', ''].join('\n'));

  write(v, 'private/Bad.md', BAD_FRONTMATTER);
  write(v, 'private/Secret Plans.md', ['---', 'title: Secret Plans', '---', '', 'Private.', ''].join('\n'));

  // Deliberately not valid UTF-8: the asset copy must be byte-for-byte.
  write(v, 'pub/img/Logo.PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]));
  return v;
}

function outPair(name) {
  const base = mkroot(name);
  return { base, outDir: path.join(base, 'content') };
}

let vault;
let base;
let outDir;
let result;

beforeAll(() => {
  vault = makeVault();
  ({ base, outDir } = outPair('out'));
  result = project(vault, outDir, { lowercase: true });
});

afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

const read = (p) => fs.readFileSync(p);
const fmOf = (p) => yaml.load(read(p).toString('utf8').split('---')[1]);

// ------------------------------------------------------------------- the basics

describe('project', () => {
  test('projects the published set and nothing else', () => {
    expect(result.ok).toBe(true);
    expect(result.counts.pages).toBe(4);
    expect(result.counts.assets).toBe(1);
    expect(fs.existsSync(path.join(outDir, 'pub/alpha note.md'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'pub/lower.md'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'pub/img/logo.png'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'private'))).toBe(false);
  });

  test('lowercases every path segment and nothing else', () => {
    expect(projectedPath('Cyber/Threat Modeling & Risk.md')).toBe('cyber/threat modeling & risk.md');
    expect(fs.existsSync(path.join(outDir, 'pub/no frontmatter.md'))).toBe(true);
  });

  test('a bad-frontmatter file that is not published is a warning, not a failure', () => {
    expect(result.ok).toBe(true);
    const w = result.warnings.find((x) => x.path === 'private/Bad.md');
    expect(w).toBeDefined();
    expect(w.kind).toBe('select');
    expect(fs.existsSync(path.join(outDir, 'private/bad.md'))).toBe(false);
  });

  test('writes the report to the parent of outDir', () => {
    const reportPath = path.join(base, 'projection-report.json');
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'projection-report.json'))).toBe(false);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    expect(report.ok).toBe(true);
    expect(report.counts.pages).toBe(4);
    expect(report.leakTest.ok).toBe(true);
  });
});

// ------------------------------------------------------------ alias injection

describe('alias injection', () => {
  test('injects the natural-case path when the projected path changes case', () => {
    const fm = fmOf(path.join(outDir, 'pub/alpha note.md'));
    expect(fm.aliases).toEqual(['pub/Alpha Note']);
    expect(fm.title).toBe('Alpha');
  });

  test('preserves existing aliases and appends', () => {
    const fm = fmOf(path.join(outDir, 'pub/has aliases.md'));
    expect(fm.aliases).toEqual(['Old Name', 'another/one', 'pub/Has Aliases']);
    expect(fm.draft).toBe(false);
    expect(fm.title).toBe('Has Aliases');
  });

  test('creates frontmatter when the page has none', () => {
    const projected = read(path.join(outDir, 'pub/no frontmatter.md'));
    const source = read(path.join(vault, 'pub/No Frontmatter.md'));
    expect(fmOf(path.join(outDir, 'pub/no frontmatter.md')).aliases).toEqual(['pub/No Frontmatter']);
    expect(projected.subarray(projected.length - source.length).equals(source)).toBe(true);
  });

  test('leaves an already-lowercase page byte-identical', () => {
    expect(read(path.join(outDir, 'pub/lower.md')).equals(read(path.join(vault, 'pub/lower.md')))).toBe(true);
  });

  test('body bytes are byte-identical after injection', () => {
    const projected = read(path.join(outDir, 'pub/alpha note.md'));
    const source = read(path.join(vault, 'pub/Alpha Note.md'));
    const marker = Buffer.from('# Alpha');
    const pTail = projected.subarray(projected.indexOf(marker));
    const sTail = source.subarray(source.indexOf(marker));
    expect(pTail.equals(sTail)).toBe(true);
    expect(sTail.length).toBeGreaterThan(0);
  });

  test('assets are copied byte-identical, including invalid UTF-8', () => {
    expect(read(path.join(outDir, 'pub/img/logo.png')).equals(read(path.join(vault, 'pub/img/Logo.PNG')))).toBe(true);
    expect(result.warnings.some((w) => w.kind === 'asset-case-change')).toBe(true);
  });

  test('an empty `aliases:` key becomes a list rather than a null entry', () => {
    // The dominant shape in the real vault: `aliases: ` with no value, in the middle of
    // the frontmatter. The key moves to the end; every other key keeps its value.
    const src = Buffer.from(['---', 'aliases: ', 'title: Kept', '---', '', 'body', ''].join('\n'));
    const out = injectAlias(src, 'Some/Page');
    expect(out.injected).toBe(true);
    const fm = yaml.load(out.buffer.toString('utf8').split('---')[1]);
    expect(fm.aliases).toEqual(['Some/Page']);
    expect(fm.title).toBe('Kept');
  });

  test('injectAlias is a no-op when the alias is already present', () => {
    const src = Buffer.from(['---', 'aliases: [Kept]', '---', '', 'body', ''].join('\n'));
    expect(injectAlias(src, 'Kept').injected).toBe(false);
    const added = injectAlias(src, 'New');
    expect(added.injected).toBe(true);
    expect(yaml.load(added.buffer.toString('utf8').split('---')[1]).aliases).toEqual(['Kept', 'New']);
  });
});

// ---------------------------------------------------------------- the failures

describe('build failures', () => {
  test('pre-flight fails the build, by name, on a published page with bad frontmatter', () => {
    const bad = preflightFrontmatter(vault, ['private/Bad.md', 'pub/lower.md']);
    expect(bad.failures.length).toBe(1);
    expect(bad.failures[0].path).toBe('private/Bad.md');

    // The selector fails bad frontmatter closed, so reaching the projection with one is
    // only possible if the vault changed under us or a future selector stops parsing.
    // The gate exists for that: Quartz aborts the whole build on one bad file (R14).
    const real = select(vault);
    const forced = {
      published: real.published,
      errors: [],
      report: { ...real.report, published: { pages: [...real.report.published.pages, 'private/Bad.md'], assets: real.report.published.assets } },
    };
    const { outDir: o } = outPair('preflight');
    const r = project(vault, o, { selectResult: forced, writeReport: false, lowercase: true });
    expect(r.ok).toBe(false);
    const f = r.failures.find((x) => x.kind === 'preflight');
    expect(f.path).toBe('private/Bad.md');
    expect(fs.existsSync(o)).toBe(false);
  });

  test('two paths that lowercase to one output path fail the build', () => {
    const v = mkroot('collide');
    write(v, 'publish.yml', 'allow:\n  - pub\n');
    write(v, 'pub/Note.md', ['---', 'title: One', '---', '', 'one', ''].join('\n'));
    write(v, 'pub/NOTE.md', ['---', 'title: Two', '---', '', 'two', ''].join('\n'));
    const { outDir: o } = outPair('collide-out');
    const r = project(v, o, { writeReport: false, lowercase: true });
    expect(r.ok).toBe(false);
    const f = r.failures.find((x) => x.kind === 'case-collision');
    expect(f.path).toBe('pub/note.md');
    expect(f.sources).toEqual(['pub/NOTE.md', 'pub/Note.md']);
    expect(fs.existsSync(o)).toBe(false);
  });

  test('findCaseCollisions groups only real collisions', () => {
    expect(findCaseCollisions(['a/B.md', 'a/b.md', 'c.md'])).toEqual([{ projected: 'a/b.md', sources: ['a/B.md', 'a/b.md'] }]);
  });

  test('a missing publish.yml fails the build', () => {
    const v = mkroot('noconfig');
    write(v, 'pub/Note.md', '# note\n');
    const { outDir: o } = outPair('noconfig-out');
    const r = project(v, o, { writeReport: false, lowercase: true });
    expect(r.ok).toBe(false);
    expect(r.failures[0].kind).toBe('config');
    expect(fs.existsSync(o)).toBe(false);
  });
});

// ----------------------------------------------------------------- leak test

describe('leak test', () => {
  test('catches a planted non-published file under outDir', () => {
    const selectResult = result.selectResult;
    expect(verifyProjection(vault, outDir, selectResult, { lowercase: true }).ok).toBe(true);

    const planted = path.join(outDir, 'private/secret plans.md');
    fs.mkdirSync(path.dirname(planted), { recursive: true });
    fs.copyFileSync(path.join(vault, 'private/Secret Plans.md'), planted);

    const after = verifyProjection(vault, outDir, selectResult, { lowercase: true });
    expect(after.ok).toBe(false);
    expect(after.unexpected).toContain('private/secret plans.md');
    expect(after.deniedPresent.map((d) => d.source)).toContain('private/Secret Plans.md');

    fs.rmSync(path.join(outDir, 'private'), { recursive: true, force: true });
    expect(verifyProjection(vault, outDir, selectResult, { lowercase: true }).ok).toBe(true);
  });

  test('reports a denied title found in published text without failing the build', () => {
    const v = verifyProjection(vault, outDir, result.selectResult, { lowercase: true });
    expect(v.ok).toBe(true);
    expect(v.checked.sampledTitles).toBeGreaterThan(0);
    // "Secret Plans" survives in the body of pub/Alpha Note.md as a stripped wikilink.
    expect(v.titleMatches.map((m) => m.title)).toContain('Secret Plans');
  });
});

// ---------------------------------------------------------- derived-path lint

describe('derived-path lint', () => {
  test('warns about a URL in a tags array', () => {
    const w = result.warnings.find((x) => x.kind === 'derived-path');
    expect(w.path).toBe('pub/Alpha Note.md');
    expect(w.key).toBe('tags');
    expect(w.chars).toContain(':');
    expect(result.ok).toBe(true);
  });
});

// R16: v0 deploys verbatim paths (default lowercase:false). Pages and assets in one
// source folder must land in ONE output folder so relative references survive.
import { projectedPath as pp } from '../src/project.js';
test('R16 default: paths are verbatim, no aliases injected, relative co-location preserved', () => {
  expect(pp('Notes/My Page.md', false)).toBe('Notes/My Page.md');
  const vault = mkroot('verbatim');
  write(vault, 'publish.yml', 'allow:\n  - "Cyber/**"\n');
  write(vault, 'Cyber/Page One.md', '---\ntitle: One\n---\n\n![local](img/Shot.PNG)\n');
  write(vault, 'Cyber/img/Shot.PNG', Buffer.from([137, 80, 78, 71]));
  const o = mkroot('verbatim-out');
  const r = project(vault, o, { writeReport: false });
  expect(r.ok).toBe(true);
  expect(r.counts.aliasesInjected).toBe(0);
  expect(fs.existsSync(path.join(o, 'Cyber/Page One.md'))).toBe(true);
  expect(fs.existsSync(path.join(o, 'Cyber/img/Shot.PNG'))).toBe(true);
});
