import { afterEach, describe, expect, test } from 'bun:test';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { Readable } from 'node:stream';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stageOwnerAlphaConfig } from '../stage-config.js';
import { runCredentialHelper } from '../git-credential-owner-alpha-socket.js';
import { checkOwnerAlphaHealth } from '../healthcheck.js';
import {
  OWNER_ALPHA_READY_CONTENT,
  writeOwnerAlphaReadyMarker,
} from '../../../apps/owner-alpha/src/server.js';

const ROOT = path.resolve(import.meta.dir, '../../..');
const CONTAINER_CONFIG = path.join(ROOT, 'deploy', 'owner-alpha', 'owner-alpha.container.example.json');
const cleanup = [];

async function tempRoot(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(root);
  return root;
}

async function configObject(change = null) {
  const value = JSON.parse(await readFile(CONTAINER_CONFIG, 'utf8'));
  change?.(value);
  return value;
}

async function privateConfig(file, change = null) {
  await writeFile(file, `${JSON.stringify(await configObject(change), null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

function outputCollector() {
  const chunks = [];
  return {
    output: { write(value) { chunks.push(Buffer.from(value)); } },
    text() { return Buffer.concat(chunks).toString('utf8'); },
  };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('private config staging', () => {
  test('copies a regular source into a private owned 0600 destination and validates the container contract', async () => {
    const root = await tempRoot('owner-alpha-stage-');
    const run = path.join(root, 'run');
    const source = path.join(root, 'source.json');
    const destination = path.join(run, 'owner-alpha.local.json');
    await Bun.write(source, await Bun.file(CONTAINER_CONFIG).arrayBuffer());
    await chmod(source, 0o644);
    await mkdir(run, { mode: 0o700 });

    const config = await stageOwnerAlphaConfig({
      source,
      destination,
      interfaces: { lo: [{ address: '127.0.0.1', family: 'IPv4' }] },
      requireContainerContract: true,
    });
    const metadata = await lstat(destination);
    expect(config.repository.checkout).toBe('/vault');
    expect(metadata.isFile()).toBe(true);
    expect(metadata.nlink).toBe(1);
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(metadata.uid).toBe(process.getuid());
    expect(metadata.gid).toBe(process.getgid());
    expect(await readFile(destination)).toEqual(await readFile(source));
    await expect(stageOwnerAlphaConfig({ source, destination })).rejects.toThrow('must be absent');
  });

  test('rejects symlink, oversized, malformed, wrong checkout, and unassigned-address inputs without retaining an active copy', async () => {
    const root = await tempRoot('owner-alpha-stage-negative-');
    const run = path.join(root, 'run');
    await mkdir(run, { mode: 0o700 });

    const regular = path.join(root, 'regular.json');
    await privateConfig(regular);
    const linked = path.join(root, 'linked.json');
    await symlink(regular, linked);
    await expect(stageOwnerAlphaConfig({
      source: linked,
      destination: path.join(run, 'linked-active.json'),
      interfaces: { lo: [{ address: '127.0.0.1', family: 'IPv4' }] },
    })).rejects.toThrow();

    const oversized = path.join(root, 'oversized.json');
    await writeFile(oversized, Buffer.alloc(256 * 1024 + 1, 0x20), { mode: 0o600 });
    await expect(stageOwnerAlphaConfig({
      source: oversized,
      destination: path.join(run, 'oversized-active.json'),
      interfaces: {},
    })).rejects.toThrow('source config must contain');

    for (const [name, mutate, message] of [
      ['malformed', null, 'strict JSON'],
      ['checkout', (value) => { value.repository.checkout = '/other'; }, 'exactly /vault'],
      ['address', (value) => { value.listen.host = '10.10.10.10'; }, 'not assigned'],
    ]) {
      const source = path.join(root, `${name}.json`);
      const destination = path.join(run, `${name}-active.json`);
      if (name === 'malformed') await writeFile(source, '{\n', { mode: 0o600 });
      else await privateConfig(source, mutate);
      await expect(stageOwnerAlphaConfig({
        source,
        destination,
        interfaces: { lo: [{ address: '127.0.0.1', family: 'IPv4' }] },
        requireContainerContract: true,
      })).rejects.toThrow(message);
      await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});

describe('credential socket helper', () => {
  test('forwards only one exact HTTPS repository request and returns the bounded broker response', async () => {
    const root = await tempRoot('owner-alpha-credential-');
    const configFile = path.join(root, 'config.json');
    const socketPath = path.join(root, 'helper.sock');
    await privateConfig(configFile);
    let received = '';
    const server = createNetServer((socket) => {
      const chunks = [];
      socket.on('data', (chunk) => {
        chunks.push(Buffer.from(chunk));
        received = Buffer.concat(chunks).toString('utf8');
        if (received.endsWith('\n\n')) {
          socket.end('username=fake-owner\npassword=fake-test-value\n\n');
        }
      });
    });
    await new Promise((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));
    cleanup.push(socketPath);

    const request = 'protocol=https\nhost=github.com\npath=cybersader/cyberbase.git\n\n';
    const collected = outputCollector();
    await runCredentialHelper({
      operation: 'get',
      input: Readable.from([request]),
      output: collected.output,
      configFile,
      socketPath,
    });
    expect(received).toBe(request);
    expect(collected.text()).toBe('username=fake-owner\npassword=fake-test-value\n\n');

    await expect(runCredentialHelper({
      operation: 'get',
      input: Readable.from(['protocol=https\nhost=github.com\npath=other/repository.git\n\n']),
      output: outputCollector().output,
      configFile,
      socketPath,
    })).rejects.toThrow('does not match');

    const erased = outputCollector();
    await runCredentialHelper({
      operation: 'erase',
      input: Readable.from([request]),
      output: erased.output,
      configFile,
      socketPath,
    });
    expect(erased.text()).toBe('');
    await new Promise((resolve) => server.close(resolve));
  });

  test('rejects oversized requests and broker responses that carry another repository identity', async () => {
    const root = await tempRoot('owner-alpha-credential-negative-');
    const configFile = path.join(root, 'config.json');
    const socketPath = path.join(root, 'helper.sock');
    await privateConfig(configFile);

    await expect(runCredentialHelper({
      operation: 'get',
      input: Readable.from([`protocol=https\nhost=github.com\npath=${'x'.repeat(17 * 1024)}\n\n`]),
      output: outputCollector().output,
      configFile,
      socketPath,
    })).rejects.toThrow('too large');

    const server = createNetServer((socket) => {
      let request = '';
      socket.on('data', (chunk) => {
        request += chunk.toString('utf8');
        if (request.endsWith('\n\n')) {
          socket.end('username=fake-owner\npassword=fake-test-value\nhost=other.invalid\n\n');
        }
      });
    });
    await new Promise((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));
    cleanup.push(socketPath);
    await expect(runCredentialHelper({
      operation: 'get',
      input: Readable.from(['protocol=https\nhost=github.com\npath=cybersader/cyberbase.git\n\n']),
      output: outputCollector().output,
      configFile,
      socketPath,
    })).rejects.toThrow('invalid response');
    await new Promise((resolve) => server.close(resolve));
  });
});

describe('readiness health check', () => {
  test('requires the private marker and an exact-Host reader response', async () => {
    const root = await tempRoot('owner-alpha-health-');
    const run = path.join(root, 'run');
    const readyFile = path.join(run, 'ready');
    const configFile = path.join(run, 'config.json');
    await mkdir(run, { mode: 0o700 });

    let seenHost;
    const server = createHttpServer((request, response) => {
      seenHost = request.headers.host;
      response.writeHead(request.url === '/cyberbase/' ? 200 : 404);
      response.end('ok');
    });
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    const readerPort = server.address().port;
    await privateConfig(configFile, (value) => {
      value.listen.port = readerPort - 1;
      delete value.listen.readerPort;
    });

    await expect(checkOwnerAlphaHealth({ configFile, readyFile })).rejects.toThrow();
    await writeOwnerAlphaReadyMarker(readyFile);
    expect(await readFile(readyFile, 'utf8')).toBe(OWNER_ALPHA_READY_CONTENT);
    expect((await lstat(readyFile)).mode & 0o777).toBe(0o600);
    await checkOwnerAlphaHealth({ configFile, readyFile });
    expect(seenHost).toBe(`127.0.0.1:${readerPort}`);
    await new Promise((resolve) => server.close(resolve));
  });
});
