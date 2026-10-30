import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { computePolicyRevision, policyDocument, validateOwnerAlphaConfig } from '../src/config.js';
import { OwnerAlphaError } from '../src/errors.js';
import { applyEditorOperation } from '../src/operation.js';
import { detectYamlFrontmatterRange, liveUrlForSlug } from '../src/source.js';
import {
  OWNER_PUBLICATION_ARTIFACT_TYPE,
  prepareOwnerPublication,
  readAuthoringSource,
  revalidateOwnerPublicationSource,
} from '../src/owner-publication.js';

// Only the tracked public example is read. No checkout, host, store or Git process
// is used: all source/session fixtures below are synthetic in-memory evidence.
const EXAMPLE = JSON.parse(await readFile(new URL('../owner-alpha.example.json', import.meta.url), 'utf8'));
const BASE = '---\ntitle: Fixture\n---\nBefore old after.\n';
const EDITED = BASE.replace('old', 'new café');
const MAPPING = {
  id: 'pilot-page',
  source: { identity: 'source-fixture', path: 'Drafts/Page.md' },
  relativePath: 'Notes/Page.md',
  slug: 'Notes/example-page',
};

function digest(bytes) {
  return `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
}

function configWith(change = () => {}) {
  const raw = structuredClone(EXAMPLE);
  raw.repository = { checkout: '/synthetic/not-opened', remote: { name: 'origin', url: 'https://github.com/example/fixture.git' }, branch: 'main' };
  raw.owner.identity = 'example';
  raw.live.baseUrl = 'https://example.github.io/fixture/';
  raw.workflow.repository = 'example/fixture';
  raw.ownerPublication = { enabled: true, mappings: [structuredClone(MAPPING)] };
  Object.assign(raw.limits, { maxSourceBytes: 4096, maxReplacementBytes: 128, maxChangedBytes: 128, maxChangedLines: 6, maxArtifactBytes: 32768 });
  change(raw);
  return validateOwnerAlphaConfig(raw);
}

function note(text = EDITED, version = 7) {
  const bytes = Buffer.from(text, 'utf8');
  return {
    ...MAPPING.source, version, byteLength: bytes.length, digest: digest(bytes),
    text, bytesBase64: bytes.toString('base64'),
  };
}

function sessionFor(config, text = BASE) {
  const bytes = Buffer.from(text, 'utf8');
  return {
    schemaVersion: 1, artifactType: 'owner-alpha-edit-session',
    relativePath: MAPPING.relativePath, slug: MAPPING.slug,
    liveUrl: liveUrlForSlug(config.live.baseUrl, MAPPING.slug),
    baseCommit: 'a'.repeat(40), policyRevision: computePolicyRevision(config),
    source: {
      text, bytesBase64: bytes.toString('base64'), byteLength: bytes.length,
      digest: digest(bytes), gitMode: '100644', gitObjectId: 'b'.repeat(40),
      frontmatter: detectYamlFrontmatterRange(bytes),
    },
  };
}

async function expectCode(action, code) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected OwnerAlphaError(${code})`);
}

function capture(value, config = configWith()) {
  return readAuthoringSource({ config, mappingId: MAPPING.id, readNote: async () => value });
}

function prepare({ config = configWith(), base = BASE, edited = EDITED, readNote = async () => note(edited), ...options } = {}) {
  return prepareOwnerPublication({ config, mappingId: MAPPING.id, readNote, session: sessionFor(config, base), ...options });
}

function deeplyFrozen(value) {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) deeplyFrozen(child);
}

describe('optional bounded publication configuration', () => {
  test('absent and explicitly off preserve the pinned policy and normalized revalidation', () => {
    const absent = structuredClone(EXAMPLE);
    delete absent.ownerPublication;
    const off = { ...absent, ownerPublication: { enabled: false } };
    for (const raw of [absent, off]) {
      const config = validateOwnerAlphaConfig(raw);
      expect(config.ownerPublication).toEqual({ enabled: false });
      expect(validateOwnerAlphaConfig(config)).toEqual(config);
      expect(computePolicyRevision(config)).toBe('sha256:e740f0cf94abb24d230a56b7290a808ddad81d7836d8a5eefaa7aee3d83a2c22');
      expect(policyDocument(config)).not.toHaveProperty('ownerPublication');
    }
  });

  test('enabled mapping is immutable and every source/target scope field changes policy', () => {
    const config = configWith();
    deeplyFrozen(config.ownerPublication);
    expect(validateOwnerAlphaConfig(config)).toEqual(config);
    expect(policyDocument(config).ownerPublication).toEqual(config.ownerPublication);
    const revision = computePolicyRevision(config);
    for (const change of [
      (map) => { map.id = 'other-map'; },
      (map) => { map.source.identity = 'other-source'; },
      (map) => { map.source.path = 'Drafts/Other.md'; },
      (map) => { map.relativePath = 'Notes/Other.md'; },
      (map) => { map.slug = 'Notes/other-page'; },
    ]) {
      expect(computePolicyRevision(configWith((raw) => change(raw.ownerPublication.mappings[0])))).not.toBe(revision);
    }
  });

  test('permits exactly one map only while enabled', async () => {
    for (const value of [null, { enabled: 'yes' }, { enabled: true, mappings: [] },
      { enabled: true, mappings: [MAPPING, MAPPING] }, { enabled: false, mappings: [MAPPING] }]) {
      await expectCode(() => configWith((raw) => { raw.ownerPublication = value; }),
        value?.enabled === false ? 'unknown-config-key' : 'invalid-config');
    }
  });

  test('rejects unknown and missing fields at each new boundary', async () => {
    for (const location of [[], ['mappings', 0], ['mappings', 0, 'source']]) {
      for (const mode of ['unknown', 'missing']) {
        await expectCode(() => configWith((raw) => {
          let target = raw.ownerPublication;
          for (const key of location) target = target[key];
          if (mode === 'unknown') target.endpoint = 'not-allowed';
          else delete target[location.length === 0 ? 'mappings' : location.at(-1) === 'source' ? 'identity' : 'relativePath'];
        }), mode === 'unknown' ? 'unknown-config-key' : 'missing-config-key');
      }
    }
    await expectCode(() => configWith((raw) => { raw.ownerPublication.token = 'synthetic'; }), 'credentials-forbidden');
  });

  for (const field of ['source.path', 'relativePath', 'slug']) {
    test(`rejects absolute/traversal/control/URL/unbounded ${field}`, async () => {
      for (const value of ['../x', '/x', './x', 'a/../x', 'a//x', 'a\\x', 'C:/x', 'https://example.invalid/x',
        'x\u0000y', 'x\ny', 'x%2Fy', 'x?query', 'x#hash', 'x/*', 'x/'.repeat(600), 'x\uD800']) {
        await expectCode(() => configWith((raw) => {
          const map = raw.ownerPublication.mappings[0];
          if (field === 'source.path') map.source.path = value;
          else map[field] = value;
        }), value.includes('\u0000') || value.includes('\n') ? 'invalid-config' : 'invalid-config-path');
      }
    });
  }

  test('rejects inexact or non-opaque identities and non-Markdown repo targets', async () => {
    for (const value of [' source', 'source ', '../source', '/source', 'a:b', 'a/b', 'a\n', 'a'.repeat(129)]) {
      for (const field of ['id', 'identity']) {
        await expectCode(() => configWith((raw) => {
          const map = raw.ownerPublication.mappings[0];
          (field === 'id' ? map : map.source)[field] = value;
        }), 'invalid-config');
      }
    }
    for (const relativePath of ['Notes/Page.MD', 'Notes/.md']) {
      await expectCode(() => configWith((raw) => { raw.ownerPublication.mappings[0].relativePath = relativePath; }), 'invalid-config-path');
    }
  });

  test('configured id alone selects the mapping; off, unknown ids, and excluded scopes call no dependencies', async () => {
    let calls = 0;
    const readNote = async () => { calls += 1; return note(); };
    const createEditSession = async () => { calls += 1; throw new Error('must not run'); };
    for (const [config, mappingId, code] of [
      [configWith((raw) => { delete raw.ownerPublication; }), MAPPING.id, 'owner-publication-disabled'],
      [configWith(), 'other-page', 'publication-mapping-not-found'],
      [configWith(), { id: MAPPING.id, path: 'Other.md' }, 'publication-mapping-not-found'],
      [configWith((raw) => { raw.paths.include = ['Public/**/*.md']; }), MAPPING.id, 'source-path-not-included'],
      [configWith((raw) => { raw.paths.exclude.push('Notes/**'); }), MAPPING.id, 'source-path-excluded'],
    ]) {
      await expectCode(() => prepareOwnerPublication({ config, mappingId, readNote, createEditSession }), code);
    }
    expect(calls).toBe(0);
  });
});

describe('injected coherent single-note evidence', () => {
  test('receives only the frozen configured binding and returns an immutable detached capture', async () => {
    const raw = note();
    const config = configWith();
    const captured = await readAuthoringSource({ config, mappingId: MAPPING.id, readNote: async (binding) => {
      expect(binding).toEqual(MAPPING);
      deeplyFrozen(binding);
      return raw;
    } });
    expect(captured).toEqual(raw);
    expect(captured).not.toBe(raw);
    deeplyFrozen(captured);
    raw.text = 'changed after return';
    expect(captured.text).toBe(EDITED);
  });

  test('requires an explicitly supplied reader', async () => {
    await expectCode(() => readAuthoringSource({ config: configWith(), mappingId: MAPPING.id }), 'authoring-reader-required');
  });

  for (const key of Object.keys(note())) {
    test(`rejects missing reader ${key}`, async () => {
      const raw = note();
      delete raw[key];
      await expectCode(() => capture(raw), 'invalid-authoring-note');
    });
  }

  test('rejects unknown fields, non-records, symbol fields and accessor payloads without invoking accessors', async () => {
    for (const value of [null, [], 'body', { ...note(), endpoint: 'forbidden' }, { ...note(), [Symbol('hidden')]: true }]) {
      await expectCode(() => capture(value), 'invalid-authoring-note');
    }
    const accessor = note();
    Object.defineProperty(accessor, 'text', { get() { throw new Error('sensitive-body'); } });
    await expectCode(() => capture(accessor), 'invalid-authoring-note');
  });

  for (const field of ['identity', 'path']) {
    test(`rejects reader ${field} substitution, including case and whitespace`, async () => {
      for (const value of ['other', `${MAPPING.source[field]} `, MAPPING.source[field].toUpperCase()]) {
        await expectCode(() => capture({ ...note(), [field]: value }), 'authoring-source-binding-mismatch');
      }
    });
  }

  test('rejects zero, negative, unsafe, nonnumeric and missing coherent versions', async () => {
    for (const version of [0, -1, 1.5, '7', null, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      await expectCode(() => capture(note(EDITED, version)), 'invalid-authoring-version');
    }
    expect((await capture(note(EDITED, Number.MAX_SAFE_INTEGER))).version).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('rejects partial, wrong and same-length different bytes, text, lengths and digests', async () => {
    const raw = note();
    for (const changed of [
      { text: raw.text.slice(0, -2), bytesBase64: Buffer.from(raw.text.slice(0, -2)).toString('base64') },
      { text: raw.text.replace('new', 'NEW') },
      { bytesBase64: Buffer.from(raw.text.replace('new', 'NEW')).toString('base64') },
      { text: raw.text.replace('new', 'NEW'), bytesBase64: Buffer.from(raw.text.replace('new', 'NEW')).toString('base64') },
      { byteLength: raw.byteLength - 1 }, { digest: digest(Buffer.from('wrong')) },
    ]) {
      await expectCode(() => capture({ ...raw, ...changed }), 'authoring-source-integrity-mismatch');
    }
    for (const byteLength of [-1, 1.5, '9', null]) {
      await expectCode(() => capture({ ...raw, byteLength }), 'invalid-authoring-length');
    }
    for (const invalidDigest of ['sha256:abcd', raw.digest.replace('sha-256', 'SHA-256'), `${raw.digest} `, 'sha-256=:AAAA:']) {
      await expectCode(() => capture({ ...raw, digest: invalidDigest }), 'invalid-authoring-digest');
    }
  });

  test('rejects malformed/noncanonical base64, malformed UTF-8 and surrogate text', async () => {
    for (const bytesBase64 of ['***=', 'YQ', 'YQ===', 'YR==', 'YQ==\n', null]) {
      await expectCode(() => capture({ ...note(), bytesBase64 }), 'invalid-authoring-bytes');
    }
    for (const bytes of [Buffer.from([0xff]), Buffer.from([0xc3]), Buffer.from([0xed, 0xa0, 0x80])]) {
      await expectCode(() => capture({ ...note(), text: '\uFFFD', bytesBase64: bytes.toString('base64'), byteLength: bytes.length, digest: digest(bytes) }), 'invalid-authoring-utf8');
    }
    await expectCode(() => capture({ ...note(), text: '\uD800' }), 'invalid-authoring-utf8');
  });

  test('preserves BOM and Unicode bytes at capture; refuses a BOM-stripped projection', async () => {
    const raw = note('\uFEFFbody café e\u0301\n');
    const result = await capture(raw);
    expect(result).toEqual(raw);
    expect(Buffer.from(result.bytesBase64, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    await expectCode(() => capture({ ...raw, text: raw.text.slice(1) }), 'authoring-source-integrity-mismatch');
    const decomposed = note('e\u0301\n');
    await expectCode(() => capture({ ...decomposed, text: 'é\n' }), 'authoring-source-integrity-mismatch');
  });

  test('enforces source byte limits before decoding and on multibyte/actual decoded bytes', async () => {
    const config = configWith((raw) => { raw.limits.maxSourceBytes = 128; });
    for (const raw of [note('a'.repeat(129)), { ...note('a'.repeat(129)), byteLength: 1 },
      { ...note('é'.repeat(65)), byteLength: 1 }, { ...note('a'.repeat(128)), bytesBase64: Buffer.alloc(129).toString('base64') }]) {
      await expectCode(() => capture(raw, config), 'authoring-source-too-large');
    }
    expect((await capture(note('é'.repeat(64)), config)).byteLength).toBe(128);
  });

  test('reader failures disclose no underlying message, body, code, details or cause', async () => {
    for (const underlying of [new Error('sensitive-body credential=synthetic'),
      new OwnerAlphaError('sensitive-code', 'sensitive-message', { body: 'sensitive-body' }),
      { message: 'sensitive-message', body: 'sensitive-body', code: 'sensitive-code' }]) {
      const error = await expectCode(() => readAuthoringSource({ config: configWith(), mappingId: MAPPING.id,
        readNote: async () => { throw underlying; } }), 'authoring-read-failed');
      expect(error.message).toBe('configured authoring note could not be read coherently');
      expect(error.details).toEqual({});
      expect(error.cause).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain('sensitive');
    }
  });
});

describe('effect-free publication candidate preparation', () => {
  test('creates the existing session with the configured target and replays exact operation bytes', async () => {
    const config = configWith();
    const calls = [];
    const result = await prepareOwnerPublication({ config, mappingId: MAPPING.id,
      readNote: async (mapping) => { calls.push(['read', mapping]); return note(); },
      createEditSession: async (input) => { calls.push(['session', input]); return sessionFor(config); } });
    expect(calls.map(([name]) => name)).toEqual(['read', 'session']);
    expect(calls[1][1]).toEqual({ config, renderer: { relativePath: MAPPING.relativePath, slug: MAPPING.slug } });
    expect(result.artifactType).toBe(OWNER_PUBLICATION_ARTIFACT_TYPE);
    expect(result.schemaVersion).toBe(1);
    expect(result.reference).toEqual({ mapping: MAPPING, policyRevision: computePolicyRevision(config),
      source: { ...MAPPING.source, version: 7, byteLength: note().byteLength, digest: note().digest } });
    expect(result.session.baseCommit).toBe('a'.repeat(40));
    const replayed = applyEditorOperation(result.session, result.operation);
    expect(replayed.toString('base64')).toBe(note().bytesBase64);
    expect(result.candidate).toEqual({ text: EDITED, bytesBase64: note().bytesBase64, byteLength: replayed.length, digest: digest(replayed) });
    expect(result.operation.candidateDigest).toBe(result.candidate.digest);
    deeplyFrozen(result);
    // No effectful dependency is supplied or imported by this foundation.
    expect(Object.keys(result)).toEqual(['schemaVersion', 'artifactType', 'reference', 'session', 'operation', 'candidate']);
  });

  test('reuses and detaches a supplied session without invoking its creator', async () => {
    const config = configWith();
    const session = sessionFor(config);
    const result = await prepare({ config, session, createEditSession: async () => { throw new Error('must not run'); } });
    session.source.text = 'changed later';
    expect(result.session.source.text).toBe(BASE);
    expect(Object.isFrozen(session)).toBe(false);
  });

  test('retains exact decomposed Unicode without normalization', async () => {
    const edited = BASE.replace('old', 'e\u0301');
    const result = await prepare({ edited });
    expect(result.candidate.bytesBase64).toBe(Buffer.from(edited).toString('base64'));
    expect(result.candidate.text).not.toBe(edited.normalize('NFC'));
  });

  for (const [label, edited, code] of [
    ['CRLF', EDITED.replaceAll('\n', '\r\n'), 'editor-value-not-lf-only'],
    ['bare CR', `${EDITED}\r`, 'editor-value-not-lf-only'],
    ['frontmatter', BASE.replace('title: Fixture', 'title: Changed'), 'frontmatter-edit-rejected'],
    ['no-op', BASE, 'no-op-edit'],
    ['large change', BASE.replace('old', 'x'.repeat(129)), 'limit-exceeded'],
    ['large line change', BASE.replace('old', 'a\nb\nc\nd\ne\nf\ng'), 'limit-exceeded'],
    ['BOM', `\uFEFF${EDITED}`, 'publication-bom-unsupported'],
  ]) {
    test(`refuses ${label} through exact evidence and existing operation checks`, async () => {
      await expectCode(() => prepare({ edited }), code);
    });
  }

  test('refuses frontmatter addition/removal and BOM-bearing or normalized-away base bytes', async () => {
    await expectCode(() => prepare({ base: 'plain\n', edited: '---\ntitle: Added\n---\nplain\n' }), 'frontmatter-edit-rejected');
    await expectCode(() => prepare({ edited: 'Before new after.\n' }), 'frontmatter-edit-rejected');
    await expectCode(() => prepare({ base: `\uFEFF${BASE}` }), 'publication-bom-unsupported');
    const config = configWith();
    const session = sessionFor(config);
    const bytes = Buffer.from(`\uFEFF${BASE}`);
    Object.assign(session.source, { bytesBase64: bytes.toString('base64'), byteLength: bytes.length, digest: digest(bytes) });
    await expectCode(() => prepare({ config, session }), 'edit-session-source-mismatch');
    await expectCode(() => prepare({ base: BASE.replaceAll('\n', '\r\n') }), 'source-not-lf-only');
  });

  test('rejects target, live URL, policy, base bytes and byte-limit session substitution', async () => {
    const config = configWith();
    for (const [field, value] of [['relativePath', 'Notes/Other.md'], ['slug', 'Notes/other'],
      ['liveUrl', 'https://other.invalid/'], ['policyRevision', `sha256:${'0'.repeat(64)}`]]) {
      const session = sessionFor(config);
      session[field] = value;
      await expectCode(() => prepare({ config, session }), 'publication-session-binding-mismatch');
    }
    const session = sessionFor(config);
    session.source.text = BASE.replace('old', 'OLD');
    await expectCode(() => prepare({ config, session }), 'edit-session-source-mismatch');
    await expectCode(() => prepare({ config, session: sessionFor(config, 'a'.repeat(4097)) }), 'publication-session-too-large');
    const staleSession = sessionFor(configWith((raw) => { raw.ownerPublication.mappings[0].source.identity = 'previous-source'; }));
    await expectCode(() => prepare({ config, session: staleSession }), 'publication-session-binding-mismatch');
  });

  test('refuses supplied and created sessions with unknown/accessor/symbol fields before cloning', async () => {
    const config = configWith();
    for (const change of [
      (session) => { session.origin = { type: 'owner-publication' }; },
      (session) => { session.source.extra = true; },
      (session) => { session[Symbol('hidden')] = true; },
      (session) => { session.source[Symbol('hidden')] = true; },
      (session) => { Object.defineProperty(session, 'source', { get() { throw new Error('sensitive-getter'); } }); },
      (session) => { Object.defineProperty(session.source, 'text', { get() { throw new Error('sensitive-getter'); } }); },
      (session) => { session.source.frontmatter.extra = true; },
      (session) => { Object.defineProperty(session.source.frontmatter, 'start', { get() { throw new Error('sensitive-getter'); } }); },
    ]) {
      for (const created of [false, true]) {
        const session = structuredClone(sessionFor(config));
        change(session);
        const error = await expectCode(() => prepareOwnerPublication({ config, mappingId: MAPPING.id, readNote: async () => note(),
          ...(created ? { createEditSession: async () => session } : { session }) }), 'invalid-edit-session');
        expect(error.message).not.toContain('sensitive');
      }
    }
  });

  test('scrubs non-cloneable known session/source values to invalid-edit-session', async () => {
    const config = configWith();
    for (const change of [
      (session) => { session.baseCommit = () => 'not data'; },
      (session) => { session.source.gitObjectId = () => 'not data'; },
      (session) => { session.source.frontmatter.start = () => 0; },
      (session) => { session.source.frontmatter = new Date(); },
      (session) => { session.source = new Proxy(session.source, { getPrototypeOf() { throw new Error('sensitive-proxy'); } }); },
    ]) {
      const session = structuredClone(sessionFor(config));
      change(session);
      const error = await expectCode(() => prepare({ config, session }), 'invalid-edit-session');
      expect(error.message).not.toContain('sensitive');
      expect(error.cause).toBeUndefined();
    }
  });

  test('refuses an oversized prepared artifact', async () => {
    const config = configWith((raw) => { raw.limits.maxArtifactBytes = 4096; });
    const base = 'a'.repeat(1800);
    await expectCode(() => prepare({ config, base, edited: `${base}b` }), 'publication-artifact-too-large');
  });
});

describe('source-only later publication revalidation', () => {
  test('accepts a matching frozen or JSON-reloaded reference and returns content-free evidence', async () => {
    const prepared = await prepare();
    for (const reference of [prepared.reference, JSON.parse(JSON.stringify(prepared.reference))]) {
      const result = await revalidateOwnerPublicationSource({ config: configWith(), reference, readNote: async () => note() });
      expect(result).toEqual(prepared.reference.source);
      expect(result).not.toHaveProperty('text');
      deeplyFrozen(result);
    }
  });

  test('refuses a newer or older version even when bytes match, and changed bytes even at the same version', async () => {
    const prepared = await prepare();
    for (const current of [note(EDITED, 8), note(EDITED, 6), note(EDITED.replace('new', 'NEW'), 7)]) {
      await expectCode(() => revalidateOwnerPublicationSource({ config: configWith(), reference: prepared.reference,
        readNote: async () => current }), 'authoring-source-stale');
    }
    await expectCode(() => revalidateOwnerPublicationSource({ config: configWith(), reference: prepared.reference,
      readNote: async () => ({ ...note(), path: 'Other.md' }) }), 'authoring-source-binding-mismatch');
    await expectCode(() => revalidateOwnerPublicationSource({ config: configWith(), reference: prepared.reference,
      readNote: async () => { throw new Error('not-authorized sensitive-body'); } }), 'authoring-read-failed');
  });

  test('rechecks current mapping and policy before calling the reader', async () => {
    const prepared = await prepare();
    let reads = 0;
    for (const change of [
      (raw) => { raw.ownerPublication.mappings[0].source.path = 'Drafts/Other.md'; },
      (raw) => { raw.ownerPublication.mappings[0].source.identity = 'other-source'; },
      (raw) => { raw.ownerPublication.mappings[0].relativePath = 'Notes/Other.md'; },
      (raw) => { raw.ownerPublication.mappings[0].slug = 'Notes/other'; },
      (raw) => { raw.limits.maxChangedLines -= 1; },
    ]) {
      await expectCode(() => revalidateOwnerPublicationSource({ config: configWith(change), reference: prepared.reference,
        readNote: async () => { reads += 1; return note(); } }), 'publication-policy-mismatch');
    }
    await expectCode(() => revalidateOwnerPublicationSource({ config: configWith((raw) => { raw.ownerPublication = { enabled: false }; }),
      reference: prepared.reference, readNote: async () => { reads += 1; return note(); } }), 'owner-publication-disabled');
    expect(reads).toBe(0);
  });

  test('caller-supplied paths and malformed references cannot replace configured authority', async () => {
    const prepared = await prepare();
    for (const [change, code] of [
      [(ref) => { ref.mapping.relativePath = 'Notes/Other.md'; }, 'publication-policy-mismatch'],
      [(ref) => { ref.mapping.source.path = 'Drafts/Other.md'; }, 'publication-policy-mismatch'],
      [(ref) => { ref.source.identity = 'other-source'; }, 'authoring-source-binding-mismatch'],
      [(ref) => { ref.source.version = 0; }, 'invalid-authoring-version'],
      [(ref) => { delete ref.source.digest; }, 'invalid-authoring-reference'],
      [(ref) => { ref.source.extra = true; }, 'invalid-authoring-reference'],
      [(ref) => { ref.extra = true; }, 'invalid-publication-reference'],
      [(ref) => { ref.source = null; }, 'invalid-authoring-reference'],
    ]) {
      const reference = structuredClone(prepared.reference);
      change(reference);
      await expectCode(() => revalidateOwnerPublicationSource({ config: configWith(), reference, readNote: async () => note() }), code);
    }
  });

  test('copies the expected source before awaiting the reader', async () => {
    const prepared = await prepare();
    const reference = structuredClone(prepared.reference);
    await expectCode(() => revalidateOwnerPublicationSource({ config: configWith(), reference, readNote: async () => {
      reference.source.version = 8;
      return note(EDITED, 8);
    } }), 'authoring-source-stale');
  });
});
