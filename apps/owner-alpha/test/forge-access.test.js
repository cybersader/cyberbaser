import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computePolicyRevision, retargetGithubRepository, validateOwnerAlphaConfig } from '../src/config.js';
import { createForgeAccess, createGithubAppAccess, createGithubHttp, createTokenAccess } from '../src/publisher/forge-access.js';
import { FAKE_CLIENT_ID, startFakeGithub } from './fake-github-process.js';

const EXAMPLE = path.join(import.meta.dir, '..', 'owner-alpha.example.json');
const REMOTE = 'https://github.com/cybersader/cyberbase.git';
let fake;
let root;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'oa-forge-'));
  fake = await startFakeGithub(root);
});
afterAll(async () => {
  await fake?.stop();
  await rm(root, { recursive: true, force: true });
});

let counter = 0;
function app(overrides = {}) {
  counter += 1;
  return createGithubAppAccess({
    clientId: FAKE_CLIENT_ID, stateDirectory: path.join(root, `state-${counter}`), remoteUrl: REMOTE,
    http: createGithubHttp({ apiBaseUrl: fake.origin, webBaseUrl: fake.origin }), secondMs: 1, ...overrides,
  });
}

async function settle(access, from = 'waiting-for-code') {
  for (let i = 0; i < 400; i++) {
    const status = await access.status();
    if (status.state !== from) return status;
    await Bun.sleep(5);
  }
  throw new Error('device flow did not settle');
}

async function signedIn(polls = ['ok'], installations = 'mixed') {
  await fake.scenario({ polls, installations, deviceFlowDisabled: false });
  const access = app();
  await access.startSignIn();
  return { access, status: await settle(access) };
}

describe('github-app device flow', () => {
  test('shows an eight-character code, waits through pending and slow_down, then asks for a repository', async () => {
    await fake.scenario({ polls: ['authorization_pending', 'slow_down', 'authorization_pending', 'ok'], installations: 'mixed', deviceFlowDisabled: false });
    const access = app();
    const started = await access.startSignIn();
    expect(started.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u);
    expect(started.verificationUri).toBe(`${fake.origin}/login/device`);
    expect(Object.keys(started).sort()).toEqual(['expiresAt', 'userCode', 'verificationUri']);
    const status = await settle(access);
    expect(status).toEqual({ provider: 'github-app', state: 'pick-repository', app: { clientId: FAKE_CLIENT_ID, slug: null, createdBy: null, signIn: 'device' } });
    expect((await fake.report()).polls.slice(-4)).toEqual(['authorization_pending', 'slow_down', 'authorization_pending', 'ok']);
  });

  test('an expired code and a cancelled sign-in say so plainly and store nothing', async () => {
    for (const [poll, problem] of [['expired_token', 'code-expired'], ['access_denied', 'denied']]) {
      await fake.scenario({ polls: ['authorization_pending', poll] });
      const access = app();
      await access.startSignIn();
      const status = await settle(access);
      expect(status.state).toBe('problem');
      expect(status.problem).toBe(problem);
      expect(status.message.length).toBeGreaterThan(10);
    }
  });

  test('a registration without device flow, or an unknown client ID, is named', async () => {
    await fake.scenario({ deviceFlowDisabled: true });
    await expect(app().startSignIn()).rejects.toMatchObject({ code: 'device-flow-disabled' });
    await fake.scenario({ deviceFlowDisabled: false });
    await expect(app({ clientId: 'Iv23liNOTREGISTERED' }).startSignIn()).rejects.toMatchObject({ code: 'app-misconfigured' });
  });

  test('device flow and refresh never send a client secret (the fake refuses one)', async () => {
    const { access, status } = await signedIn();
    expect(status.state).toBe('pick-repository');
    await access.selectRepository('cybersader/cyberbase');
    await fake.expireAccess();
    expect((await access.status({ check: true })).state).toBe('connected');
    expect((await fake.report()).refreshes).toBeGreaterThan(0);
  });
});

describe('github-app repositories and permissions', () => {
  test('lists every installation repository across pages, newest first, with its fit', async () => {
    const { access } = await signedIn();
    const { repositories, truncated } = await access.listRepositories();
    expect(truncated).toBe(false);
    expect(repositories).toHaveLength(208);
    expect(repositories[0]).toMatchObject({ fullName: 'cybersader/cyberbase', private: true, problem: null });
    const fit = Object.fromEntries(repositories.map((row) => [row.fullName, row.problem]));
    expect(fit['cybersader-lab/field-notes']).toBeNull();
    expect(fit['wide-co/handbook']).toBe('permissions-too-broad');
    expect(fit['big-org/repo-205']).toBe('app-on-other-repositories');
    expect(JSON.stringify(repositories)).not.toContain('CANARY');
  });

  test('refuses a repository whose app has more than Contents write plus Metadata read', async () => {
    const { access } = await signedIn();
    await expect(access.selectRepository('wide-co/handbook')).rejects.toMatchObject({ code: 'permissions-too-broad' });
    await expect(access.selectRepository('big-org/repo-001')).rejects.toMatchObject({ code: 'app-on-other-repositories' });
    await expect(access.selectRepository('nobody/else')).rejects.toMatchObject({ code: 'repository-not-installed' });
    await expect(access.pushCredential(REMOTE)).rejects.toMatchObject({ code: 'repository-mismatch' });
  });

  test('an over-broad installation is refused even at push time', async () => {
    const { access } = await signedIn(['ok'], 'exact');
    await access.selectRepository('cybersader/cyberbase');
    await fake.scenario({ installations: 'over-broad' });
    await expect(access.pushCredential(REMOTE)).rejects.toMatchObject({ code: 'permissions-too-broad' });
    await fake.scenario({ installations: 'mixed' });
  });

  test('binds exactly one repository; the push credential is for that one only', async () => {
    const { access } = await signedIn();
    expect(await access.selectRepository('cybersader/cyberbase')).toEqual({ repository: { fullName: 'cybersader/cyberbase', remoteUrl: REMOTE } });
    const status = await access.status();
    expect(status).toMatchObject({ state: 'connected', repository: 'cybersader/cyberbase', renewsAutomatically: true });
    const credential = await access.pushCredential(REMOTE);
    expect(credential.username).toBe('x-access-token');
    expect(credential.password.startsWith('ghu_')).toBe(true);
    await expect(access.pushCredential('https://github.com/cybersader/other.git')).rejects.toMatchObject({ code: 'repository-mismatch' });
    expect(JSON.stringify(status)).not.toContain('ghu_');
  });

  test('a binding to a repository other than the configured remote is reported, not pushed', async () => {
    const { access } = await signedIn();
    await access.selectRepository('cybersader-lab/field-notes');
    expect(await access.status()).toMatchObject({ state: 'problem', problem: 'repository-mismatch', repository: 'cybersader-lab/field-notes' });
    await expect(access.pushCredential(REMOTE)).rejects.toMatchObject({ code: 'repository-mismatch' });
  });
});

describe('github-app refresh, revocation and state', () => {
  test('a rejected token is refreshed once; the rotated refresh token replaces the old one on disk', async () => {
    const { access } = await signedIn();
    await access.selectRepository('cybersader/cyberbase');
    const first = await access.pushCredential(REMOTE);
    await fake.expireAccess();
    const second = await access.pushCredential(REMOTE);
    expect(second.password).not.toBe(first.password);
  });

  test('a token near expiry is renewed before use', async () => {
    let clock = Date.now();
    await fake.scenario({ polls: ['ok'] });
    const access = app({ now: () => clock });
    await access.startSignIn();
    await settle(access);
    await access.selectRepository('cybersader/cyberbase');
    const before = (await fake.report()).refreshes;
    clock += 8 * 3600_000;
    await access.pushCredential(REMOTE);
    expect((await fake.report()).refreshes).toBe(before + 1);
  });

  test('revocation on GitHub is noticed, the credential is forgotten, and status says connect again', async () => {
    const { access } = await signedIn();
    await access.selectRepository('cybersader/cyberbase');
    await fake.revokeAll();
    expect(await access.status({ check: true })).toMatchObject({ state: 'problem', problem: 'revoked' });
    expect(await access.status()).toMatchObject({ state: 'problem', problem: 'revoked' });
    await expect(access.pushCredential(REMOTE)).rejects.toMatchObject({ code: 'revoked' });
  });

  test('a six-month-old sign-in is expired, not silently retried', async () => {
    let clock = Date.now();
    await fake.scenario({ polls: ['ok'] });
    const access = app({ now: () => clock });
    await access.startSignIn();
    await settle(access);
    clock += 15897600 * 1000 + 1;
    await expect(access.pushCredential(REMOTE)).rejects.toMatchObject({ code: 'sign-in-expired' });
  });

  test('state is one owner-only file in an owner-only directory; disconnect removes it', async () => {
    const directory = path.join(root, 'state-disconnect');
    await fake.scenario({ polls: ['ok'] });
    const access = app({ stateDirectory: directory });
    await access.startSignIn();
    await settle(access);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(directory, 'github-app.json'))).mode & 0o777).toBe(0o600);
    await access.disconnect();
    expect(await readdir(directory)).toEqual([]);
    expect(await access.status()).toEqual({ provider: 'github-app', state: 'not-connected', app: { clientId: FAKE_CLIENT_ID, slug: null, createdBy: null, signIn: 'device' } });
  });

  test('refuses a state directory others can read', async () => {
    const directory = path.join(root, 'state-open');
    await fake.scenario({ polls: ['ok'] });
    const access = app({ stateDirectory: directory });
    await access.startSignIn();
    await settle(access);
    await chmod(directory, 0o755);
    await expect(access.status()).rejects.toMatchObject({ code: 'forge-unsafe-state' });
  });
});

describe('token provider', () => {
  const PAT = `github_pat_CANARY${'a'.repeat(40)}`;
  const token = (name) => createTokenAccess({ stateDirectory: path.join(root, name), remoteUrl: REMOTE,
    http: createGithubHttp({ apiBaseUrl: fake.origin, webBaseUrl: fake.origin }) });

  test('accepts only a fine-grained token that can push to the named repository', async () => {
    await fake.addPat(PAT, 'cybersader/cyberbase');
    const access = token('token-1');
    await expect(access.saveToken('ghp_classicclassicclassic', 'cybersader/cyberbase')).rejects.toMatchObject({ code: 'token-invalid' });
    await expect(access.saveToken(`github_pat_${'b'.repeat(40)}`, 'cybersader/cyberbase')).rejects.toMatchObject({ code: 'token-invalid' });
    await expect(access.saveToken(PAT, 'cybersader/elsewhere')).rejects.toMatchObject({ code: 'repository-not-installed' });
    expect(await access.saveToken(PAT, 'cybersader/cyberbase')).toEqual({ repository: { fullName: 'cybersader/cyberbase', remoteUrl: REMOTE } });
    expect(await access.status()).toMatchObject({ state: 'connected', renewsAutomatically: false });
    expect((await access.pushCredential(REMOTE)).password).toBe(PAT);
    await access.disconnect();
    expect(await access.status()).toEqual({ provider: 'token', state: 'not-connected' });
  });

  test('a token GitHub no longer accepts is forgotten at push time', async () => {
    const other = `github_pat_CANARY${'c'.repeat(40)}`;
    await fake.addPat(other, 'cybersader/cyberbase');
    const access = token('token-2');
    await access.saveToken(other, 'cybersader/cyberbase');
    await fake.addPat(other, 'someone/else');
    await expect(access.pushCredential(REMOTE)).rejects.toMatchObject({ code: 'repository-not-installed' });
  });
});

describe('config', () => {
  async function example() {
    return JSON.parse(await readFile(EXAMPLE, 'utf8'));
  }

  test('forgeAccess is optional, validated, and only its provider and client ID enter policy', async () => {
    const raw = await example();
    const base = computePolicyRevision(raw);
    const withApp = { ...raw, forgeAccess: { provider: 'github-app', clientId: FAKE_CLIENT_ID, stateDirectory: '/var/lib/cyberbaser-publisher/forge' } };
    const config = validateOwnerAlphaConfig(withApp);
    expect(config.forgeAccess).toEqual(withApp.forgeAccess);
    expect(computePolicyRevision(withApp)).not.toBe(base);
    expect(computePolicyRevision({ ...withApp, forgeAccess: { ...withApp.forgeAccess, stateDirectory: '/elsewhere/forge' } })).toBe(computePolicyRevision(withApp));
    expect(() => validateOwnerAlphaConfig({ ...raw, forgeAccess: { provider: 'github-app', clientId: 'nope', stateDirectory: '/x/y' } })).toThrow();
    expect(() => validateOwnerAlphaConfig({ ...raw, forgeAccess: { provider: 'github-app', clientId: FAKE_CLIENT_ID, clientSecret: 'x', stateDirectory: '/x/y' } })).toThrow();
    expect(() => validateOwnerAlphaConfig({ ...raw, forgeAccess: { provider: 'deploy-key', stateDirectory: '/x/y' } })).toThrow();
    expect(createForgeAccess(validateOwnerAlphaConfig(raw))).toBeNull();
  });

  test('picking a repository rewrites every GitHub-derived field and changes the policy revision', async () => {
    const raw = await example();
    const next = retargetGithubRepository(raw, 'cybersader-lab/field-notes');
    expect(next.repository.remote.url).toBe('https://github.com/cybersader-lab/field-notes.git');
    expect(next.workflow.repository).toBe('cybersader-lab/field-notes');
    expect(next.owner.identity).toBe('cybersader-lab');
    expect(next.live.baseUrl).toBe('https://cybersader-lab.github.io/field-notes/');
    expect(computePolicyRevision(next)).not.toBe(computePolicyRevision(raw));
    expect(computePolicyRevision(retargetGithubRepository(raw, 'cybersader/cyberbase'))).toBe(computePolicyRevision(raw));
    expect(() => retargetGithubRepository(raw, '../etc')).toThrow();
    expect(raw.repository.remote.url).toBe(REMOTE);
  });
});

