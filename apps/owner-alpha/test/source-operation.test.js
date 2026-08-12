import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OwnerAlphaError } from '../src/errors.js';
import { validateOwnerAlphaConfig } from '../src/config.js';
import {
  assertCheckoutReady,
  createEditSession,
  defaultGitRunner,
  detectYamlFrontmatterRange,
} from '../src/source.js';
import {
  applyEditorOperation,
  deriveEditorOperation,
} from '../src/operation.js';

const APP_ROOT = path.resolve(import.meta.dir, '..');
const EXAMPLE = path.join(APP_ROOT, 'owner-alpha.example.json');
const REMOTE_URL = 'https://github.com/cybersader/cyberbase.git';
const cleanup = [];

async function command(args, cwd) {
  const child = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args.join(' ')} failed: ${stderr || stdout}`);
  return stdout.trim();
}

async function rawConfig(checkout) {
  const value = JSON.parse(await readFile(EXAMPLE, 'utf8'));
  value.repository.checkout = checkout;
  return value;
}

async function fixture({
  source = '---\ntitle: Example\n---\nBefore old after\n',
  relativePath = 'Notes/Page.md',
  commitSource = true,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-source-'));
  cleanup.push(root);
  await command(['git', 'init', '-q', '-b', 'main'], root);
  await command(['git', 'config', 'user.name', 'Owner Alpha Test'], root);
  await command(['git', 'config', 'user.email', 'owner-alpha@example.invalid'], root);
  await command(['git', 'remote', 'add', 'origin', REMOTE_URL], root);
  const sourceFile = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(sourceFile), { recursive: true });
  await writeFile(sourceFile, source);
  if (commitSource) {
    await command(['git', 'add', '--', relativePath], root);
    await command(['git', 'commit', '-q', '-m', 'fixture'], root);
  } else {
    await writeFile(path.join(root, '.tracked'), 'tracked\n', 'utf8');
    await command(['git', 'add', '.tracked'], root);
    await command(['git', 'commit', '-q', '-m', 'fixture'], root);
  }
  const head = await command(['git', 'rev-parse', 'HEAD'], root);
  let remoteHead = head;
  const git = async (checkout, args, options) => {
    if (args[0] === 'ls-remote') {
      return `${remoteHead}\trefs/heads/main`;
    }
    return defaultGitRunner(checkout, args, options);
  };
  return {
    root,
    sourceFile,
    relativePath,
    head,
    git,
    setRemoteHead(value) {
      remoteHead = value;
    },
    config: validateOwnerAlphaConfig(await rawConfig(root)),
  };
}

async function sessionFor(data, overrides = {}) {
  return createEditSession({
    config: data.config,
    renderer: {
      relativePath: data.relativePath,
      slug: 'Notes/example-page',
      ...overrides,
    },
    git: data.git,
  });
}

function variantConfig(config, change) {
  const copy = structuredClone(config);
  change(copy);
  return validateOwnerAlphaConfig(copy);
}

async function expectCodeAsync(action, code) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected OwnerAlphaError(${code})`);
}

function expectCode(action, code) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected OwnerAlphaError(${code})`);
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('owner-alpha source edit session', () => {
  test('binds a clean origin-aligned tracked source without mutating it', async () => {
    const data = await fixture();
    const before = await readFile(data.sourceFile);
    const checkout = await assertCheckoutReady(data.config, { git: data.git });
    const session = await sessionFor(data);

    expect(checkout).toEqual({
      root: data.root,
      origin: REMOTE_URL,
      branch: 'main',
      head: data.head,
    });
    expect(session.relativePath).toBe('Notes/Page.md');
    expect(session.slug).toBe('Notes/example-page');
    expect(session.liveUrl).toBe('https://cybersader.github.io/cyberbase/Notes/example-page');
    expect(session.baseCommit).toBe(data.head);
    expect(session.policyRevision).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(session.source.text).toBe(before.toString('utf8'));
    expect(Buffer.from(session.source.bytesBase64, 'base64').equals(before)).toBe(true);
    expect(session.source.digest.startsWith('sha-256=:')).toBe(true);
    expect(session.source.digest.endsWith(':')).toBe(true);
    expect(session.source.frontmatter).toEqual({ start: 0, end: Buffer.byteLength('---\ntitle: Example\n---\n') });
    expect(session.source.gitMode).toBe('100644');
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.source)).toBe(true);
    expect(Object.isFrozen(session.source.frontmatter)).toBe(true);
    expect(await readFile(data.sourceFile)).toEqual(before);
    expect(await command(['git', 'status', '--porcelain=v1', '--untracked-files=all'], data.root)).toBe('');
  });

  test('uses an injected Git runner and rejects wrong branch tips and dirty status', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'owner-alpha-injected-git-'));
    cleanup.push(root);
    const config = validateOwnerAlphaConfig(await rawConfig(root));
    const head = 'a'.repeat(40);
    const outputs = new Map([
      ['rev-parse --show-toplevel', root],
      ['remote get-url origin', REMOTE_URL],
      ['remote get-url --push origin', REMOTE_URL],
      ['symbolic-ref --quiet --short HEAD', 'main'],
      ['rev-parse HEAD', head],
      ['ls-remote --refs origin refs/heads/main', `${head}\trefs/heads/main`],
      ['status --porcelain=v1 --untracked-files=all', ''],
    ]);
    const git = async (_checkout, args) => outputs.get(args.join(' '));
    expect(await assertCheckoutReady(config, { git })).toEqual({
      root,
      origin: REMOTE_URL,
      branch: 'main',
      head,
    });

    outputs.set(
      'ls-remote --refs origin refs/heads/main',
      `${'b'.repeat(40)}\trefs/heads/main`,
    );
    await expectCodeAsync(() => assertCheckoutReady(config, { git }), 'checkout-not-at-origin-branch');
    outputs.set('ls-remote --refs origin refs/heads/main', `${head}\trefs/heads/main`);
    outputs.set('remote get-url --push origin', 'ssh://unexpected.example/cyberbase.git');
    await expectCodeAsync(
      () => assertCheckoutReady(config, { git }),
      'checkout-push-origin-mismatch',
    );
    outputs.set('remote get-url --push origin', REMOTE_URL);
    outputs.set('status --porcelain=v1 --untracked-files=all', ' M Notes/Page.md');
    await expectCodeAsync(() => assertCheckoutReady(config, { git }), 'checkout-not-clean');
  });

  test('rejects renderer traversal and paths outside include/exclude policy', async () => {
    const data = await fixture();
    await expectCodeAsync(
      () => sessionFor(data, { relativePath: '../Notes/Page.md' }),
      'invalid-renderer-path',
    );
    const restricted = variantConfig(data.config, (copy) => {
      copy.paths.include = ['Published/**/*.md'];
    });
    await expectCodeAsync(
      () => createEditSession({
        config: restricted,
        renderer: { relativePath: data.relativePath, slug: 'Notes/example-page' },
        git: data.git,
      }),
      'source-path-not-included',
    );
    const excluded = variantConfig(data.config, (copy) => {
      copy.paths.exclude.push('Notes/**');
      copy.paths.exclude.sort();
    });
    await expectCodeAsync(
      () => createEditSession({
        config: excluded,
        renderer: { relativePath: data.relativePath, slug: 'Notes/example-page' },
        git: data.git,
      }),
      'source-path-excluded',
    );
  });

  test('rejects untracked, symlinked, hard-linked, oversized, invalid UTF-8, and CRLF source', async () => {
    const untracked = await fixture({ commitSource: false });
    const delegateGit = async (checkout, args, options) => {
      if (args[0] === 'status') return '';
      if (args[0] === 'ls-remote') return `${untracked.head}\trefs/heads/main`;
      const child = Bun.spawn(['git', '-C', checkout, ...args], { stdout: 'pipe', stderr: 'pipe' });
      const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      if (exitCode !== 0) throw new Error('git failed');
      return stdout.trim();
    };
    await expectCodeAsync(
      () => createEditSession({
        config: untracked.config,
        renderer: { relativePath: untracked.relativePath, slug: 'untracked' },
        git: delegateGit,
      }),
      'source-not-tracked-regular-file',
    );

    const linked = await fixture();
    await link(linked.sourceFile, path.join(linked.root, '.git', 'extra-source-link'));
    await expectCodeAsync(() => sessionFor(linked), 'source-not-single-link-regular-file');

    const symlinked = await fixture({ source: 'outside\n', relativePath: 'Real.md' });
    await symlink('Real.md', path.join(symlinked.root, 'Alias.md'));
    await command(['git', 'add', 'Alias.md'], symlinked.root);
    await command(['git', 'commit', '-q', '-m', 'symlink'], symlinked.root);
    symlinked.head = await command(['git', 'rev-parse', 'HEAD'], symlinked.root);
    symlinked.setRemoteHead(symlinked.head);
    symlinked.relativePath = 'Alias.md';
    symlinked.sourceFile = path.join(symlinked.root, 'Alias.md');
    await expectCodeAsync(() => sessionFor(symlinked), 'source-not-tracked-regular-file');

    const oversized = await fixture({ source: '0123456789\n' });
    oversized.config = variantConfig(oversized.config, (copy) => {
      copy.limits.maxReplacementBytes = 4;
      copy.limits.maxChangedBytes = 8;
      copy.limits.maxSourceBytes = 10;
    });
    await expectCodeAsync(() => sessionFor(oversized), 'source-too-large');

    const invalidUtf8 = await fixture({ source: Buffer.from([0x61, 0xff, 0x0a]) });
    await expectCodeAsync(() => sessionFor(invalidUtf8), 'source-invalid-utf8');

    const crlf = await fixture({ source: 'first\r\nsecond\r\n' });
    await expectCodeAsync(() => sessionFor(crlf), 'source-not-lf-only');
  });

  test('detects optional YAML frontmatter and fails closed on an unterminated opening', () => {
    expect(detectYamlFrontmatterRange(Buffer.from('body\n'))).toBeNull();
    expect(detectYamlFrontmatterRange(Buffer.from('---\na: b\n...\nbody\n'))).toEqual({
      start: 0,
      end: Buffer.byteLength('---\na: b\n...\n'),
    });
    expectCode(
      () => detectYamlFrontmatterRange(Buffer.from('---\na: b\nbody\n')),
      'unterminated-frontmatter',
    );
  });
});

describe('one contiguous body operation', () => {
  test('derives, binds, and reapplies one minimal exact body splice', async () => {
    const data = await fixture();
    const session = await sessionFor(data);
    const edited = session.source.text.replace('old', 'new value');
    const operation = deriveEditorOperation({ session, editedText: edited, config: data.config });
    const candidate = applyEditorOperation(session, operation);

    expect(operation.operationType).toBe('offset');
    expect(Buffer.from(operation.expectedOldBytesBase64, 'base64').toString('utf8')).toBe('old');
    expect(Buffer.from(operation.replacementBytesBase64, 'base64').toString('utf8')).toBe('new value');
    expect(operation.start).toBeGreaterThanOrEqual(session.source.frontmatter.end);
    expect(operation.changedBytes).toBe(Buffer.byteLength('new value'));
    expect(operation.changedLines).toBe(1);
    expect(operation.outsideBytesUnchanged).toBe(true);
    expect(operation.source).toEqual({
      relativePath: session.relativePath,
      slug: session.slug,
      liveUrl: session.liveUrl,
      baseCommit: session.baseCommit,
      policyRevision: session.policyRevision,
    });
    expect(candidate.toString('utf8')).toBe(edited);
    expect(Object.isFrozen(operation)).toBe(true);
    expect(Object.isFrozen(operation.source)).toBe(true);
    expect(await readFile(data.sourceFile, 'utf8')).toBe(session.source.text);
  });

  test('accepts a durable session whose frontmatter range round-tripped through canonical sorted-key JSON', async () => {
    const data = await fixture();
    const session = await sessionFor(data);
    const durable = JSON.parse(JSON.stringify(session));
    // Canonical artifact JSON sorts object keys, so the reloaded range is
    // {end, start} while a fresh detection returns {start, end}.
    durable.source = {
      ...durable.source,
      frontmatter: {
        end: session.source.frontmatter.end,
        start: session.source.frontmatter.start,
      },
    };
    expect(Object.keys(durable.source.frontmatter)).toEqual(['end', 'start']);

    const edited = session.source.text.replace('old', 'new value');
    const operation = deriveEditorOperation({ session: durable, editedText: edited, config: data.config });
    expect(applyEditorOperation(durable, operation).toString('utf8')).toBe(edited);
  });

  test('rejects every frontmatter change but allows an edit beginning at the body boundary', async () => {
    const data = await fixture();
    const session = await sessionFor(data);
    expectCode(
      () => deriveEditorOperation({
        session,
        editedText: session.source.text.replace('title: Example', 'title: Changed'),
        config: data.config,
      }),
      'frontmatter-edit-rejected',
    );
    expectCode(
      () => deriveEditorOperation({
        session,
        editedText: session.source.text.replace('---\nBefore', '--\nBefore'),
        config: data.config,
      }),
      'frontmatter-edit-rejected',
    );

    const bodyStart = session.source.frontmatter.end;
    const edited = `${session.source.text.slice(0, bodyStart)}Inserted\n${session.source.text.slice(bodyStart)}`;
    const operation = deriveEditorOperation({ session, editedText: edited, config: data.config });
    expect(operation.start).toBe(bodyStart);
    expect(applyEditorOperation(session, operation).toString('utf8')).toBe(edited);

    const plain = await fixture({ source: 'plain body\n' });
    const plainSession = await sessionFor(plain);
    expectCode(
      () => deriveEditorOperation({
        session: plainSession,
        editedText: '---\ntitle: Added\n---\nplain body\n',
        config: plain.config,
      }),
      'frontmatter-edit-rejected',
    );
  });

  test('enforces LF-only text and configured byte and line ceilings', async () => {
    const data = await fixture({ source: 'before\none\ntwo\nafter\n' });
    const session = await sessionFor(data);
    const lineConfig = variantConfig(data.config, (copy) => { copy.limits.maxChangedLines = 1; });
    const lineSession = await createEditSession({
      config: lineConfig,
      renderer: { relativePath: data.relativePath, slug: 'Notes/example-page' },
      git: data.git,
    });
    expectCode(
      () => deriveEditorOperation({
        session: lineSession,
        editedText: lineSession.source.text.replace('one\ntwo', 'replacement'),
        config: lineConfig,
      }),
      'limit-exceeded',
    );
    const byteConfig = variantConfig(data.config, (copy) => {
      copy.limits.maxReplacementBytes = 4;
      copy.limits.maxChangedBytes = 8;
    });
    const byteSession = await createEditSession({
      config: byteConfig,
      renderer: { relativePath: data.relativePath, slug: 'Notes/example-page' },
      git: data.git,
    });
    expectCode(
      () => deriveEditorOperation({
        session: byteSession,
        editedText: byteSession.source.text.replace('one', 'replacement'),
        config: byteConfig,
      }),
      'limit-exceeded',
    );
    expectCode(
      () => deriveEditorOperation({
        session,
        editedText: session.source.text.replace('one\n', 'one\r\n'),
        config: data.config,
      }),
      'editor-value-not-lf-only',
    );
    expectCode(
      () => deriveEditorOperation({ session, editedText: session.source.text, config: data.config }),
      'no-op-edit',
    );
  });

  test('rejects changed policy, tampered source binding, and tampered operation bytes', async () => {
    const data = await fixture();
    const session = await sessionFor(data);
    const edited = session.source.text.replace('old', 'new');
    const operation = deriveEditorOperation({ session, editedText: edited, config: data.config });

    const changedPolicy = variantConfig(data.config, (copy) => {
      copy.limits.maxChangedLines -= 1;
    });
    expectCode(
      () => deriveEditorOperation({ session, editedText: edited, config: changedPolicy }),
      'edit-session-policy-mismatch',
    );

    const badSession = structuredClone(session);
    badSession.source.text = badSession.source.text.replace('old', 'OLD');
    expectCode(
      () => deriveEditorOperation({ session: badSession, editedText: edited, config: data.config }),
      'edit-session-source-mismatch',
    );

    const badOperation = structuredClone(operation);
    badOperation.expectedOldBytesBase64 = Buffer.from('OLD').toString('base64');
    expectCode(() => applyEditorOperation(session, badOperation), 'old-bytes-mismatch');

    const wrongSource = structuredClone(operation);
    wrongSource.source.slug = 'different';
    expectCode(() => applyEditorOperation(session, wrongSource), 'operation-source-binding-mismatch');

    const crOperation = structuredClone(operation);
    const base = Buffer.from(session.source.bytesBase64, 'base64');
    const replacement = Buffer.from('new\r');
    const crCandidate = Buffer.concat([
      base.subarray(0, crOperation.start),
      replacement,
      base.subarray(crOperation.end),
    ]);
    crOperation.replacementBytesBase64 = replacement.toString('base64');
    crOperation.candidateByteLength = crCandidate.length;
    crOperation.candidateDigest = `sha-256=:${createHash('sha256').update(crCandidate).digest('base64')}:`;
    expectCode(() => applyEditorOperation(session, crOperation), 'candidate-not-lf-only');
  });
});
