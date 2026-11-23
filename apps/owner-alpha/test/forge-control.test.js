import { afterAll, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { OwnerAlphaError } from '../src/errors.js';
import { forgeRequest, forgeSocketPath, startForgeControl } from '../src/publisher/forge-control.js';

const roots = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

async function fixture(provider) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oa-fc-'));
  roots.push(root);
  await mkdir(path.join(root, 'ipc'), { mode: 0o700 });
  const socketPath = path.join(root, 'ipc', 'p.sock');
  const control = await startForgeControl({ socketPath, forgeAccess: provider });
  return { socketPath, control };
}

function raw(address, text) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: address });
    let reply = '';
    socket.once('connect', () => socket.write(text));
    socket.on('data', (chunk) => { reply += chunk; });
    socket.once('error', reject);
    socket.once('close', () => resolve(reply));
  });
}

const calls = [];
const provider = {
  status: async ({ check } = {}) => { calls.push(['status', check === true]); return { provider: 'github-app', state: 'connected', repository: 'a/b' }; },
  startSignIn: async () => ({ userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', expiresAt: '2026-11-23T00:15:00.000Z' }),
  cancelSignIn: async () => {},
  listRepositories: async () => ({ repositories: [], truncated: false }),
  selectRepository: async (name) => { if (name === 'x/over') throw new OwnerAlphaError('permissions-too-broad', 'no'); return { repository: { fullName: name } }; },
  disconnect: async () => { calls.push(['disconnect']); },
  close() {},
};

test('relays the fixed operations, owner-only socket, plain refusals', async () => {
  const { socketPath, control } = await fixture(provider);
  expect((await lstat(forgeSocketPath(socketPath))).mode & 0o777).toBe(0o600);
  expect(await forgeRequest({ socketPath, op: 'status' })).toMatchObject({ state: 'connected' });
  expect(await forgeRequest({ socketPath, op: 'check' })).toMatchObject({ state: 'connected' });
  expect(calls.slice(-2)).toEqual([['status', false], ['status', true]]);
  expect(await forgeRequest({ socketPath, op: 'start' })).toMatchObject({ userCode: 'ABCD-EFGH' });
  expect(await forgeRequest({ socketPath, op: 'select', repository: 'a/b' })).toEqual({ repository: { fullName: 'a/b' } });
  await expect(forgeRequest({ socketPath, op: 'select', repository: 'x/over' })).rejects.toMatchObject({ code: 'permissions-too-broad' });
  await expect(forgeRequest({ socketPath, op: 'select', repository: '../x' })).rejects.toMatchObject({ code: 'forge-invalid-request' });
  await expect(forgeRequest({ socketPath, op: 'token' })).rejects.toMatchObject({ code: 'forge-invalid-request' });
  expect(await forgeRequest({ socketPath, op: 'disconnect' })).toEqual({});
  await control.close();
});

test('refuses non-canonical, duplicate-member, oversize and unknown frames', async () => {
  const { socketPath, control } = await fixture(provider);
  const address = forgeSocketPath(socketPath);
  const refused = '{"ok":false,"code":"forge-invalid-request"}\n';
  expect(await raw(address, '{"v":1,"op":"status"}\n')).toContain('"ok":true');
  expect(await raw(address, '{ "v":1, "op":"status" }\n')).toBe(refused);
  expect(await raw(address, '{"v":1,"op":"start","op":"status"}\n')).toBe(refused);
  expect(await raw(address, '{"v":1,"op":"select","repository":"a/b","extra":1}\n')).toBe(refused);
  expect(await raw(address, '{"v":2,"op":"status"}\n')).toBe(refused);
  expect(await raw(address, `${'x'.repeat(2000)}\n`)).toBe(refused);
  await control.close();
});

test('with no provider every request is refused as unsupported', async () => {
  const { socketPath, control } = await fixture(null);
  await expect(forgeRequest({ socketPath, op: 'status' })).rejects.toMatchObject({ code: 'forge-unsupported' });
  await control.close();
});
