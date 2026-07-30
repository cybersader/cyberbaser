import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  createDogfoodReaderHandler,
  discoverTailscaleSelf,
  loadDogfoodReaderSnapshot,
  parseExpiresMinutes,
  runTailscaleStatusCommand,
  startDogfoodReaderServer,
} from '../src/dogfood-reader-server.js';
import {
  attemptPaths,
  initializeAttempt,
  initializeOwnerDogfoodSeries,
} from '../src/pilot-workspace.js';

const PROJECT_ROOT = path.resolve(import.meta.dir, '../../..');
const cleanup = [];

async function command(args, cwd) {
  const process = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function rawHttp(port, request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => socket.write(request));
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

function dogfoodSeries() {
  return {
    schemaVersion: 1,
    artifactType: 'private-owner-self-dogfood-series-charter',
    profile: 'owner-self-dogfood',
    attemptIds: ['OD-01', 'OD-02', 'OD-03'],
    obligationAssignments: {
      'normal-correction': 'OD-01',
      'signed-out-mobile-handoff': 'OD-01',
      'stale-source': 'OD-02',
      'ambiguous-quote': 'OD-02',
      'owner-rejection': 'OD-03',
    },
    plannedSignedOutMobile: {
      attemptId: 'OD-01',
      device: 'Owner phone',
      operatingSystem: 'Mobile OS',
      browser: 'Mobile browser',
      signedIn: false,
    },
    evidenceClassification: {
      evidenceClass: 'owner-self-dogfood',
      countsTowardHumanPilot: false,
      independentOwnerEvidence: false,
      claimBoundary: 'maintainer operational and mechanical evidence only',
    },
  };
}

async function workspaceRoot() {
  const root = await mkdtemp(path.join(PROJECT_ROOT, '.workspace', 'dogfood-server-test-'));
  cleanup.push(root);
  return root;
}

async function cyberbaseCheckout() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dogfood-server-cyberbase-'));
  cleanup.push(root);
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'guide.md'), '# Guide\n\nOwner-selected sentence.\n', 'utf8');
  for (const args of [
    ['git', 'init', '-q'],
    ['git', 'config', 'user.email', 'test@example.org'],
    ['git', 'config', 'user.name', 'Test User'],
    ['git', 'add', '.'],
    ['git', 'commit', '-q', '-m', 'fixture'],
    ['git', 'remote', 'add', 'origin', 'https://github.com/cybersader/cyberbase.git'],
  ]) {
    const result = await command(args, root);
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  }
  return root;
}

async function initializedDogfood() {
  const workspaceRootValue = await workspaceRoot();
  await initializeOwnerDogfoodSeries({
    charter: dogfoodSeries(),
    projectRoot: PROJECT_ROOT,
    workspaceRoot: workspaceRootValue,
  });
  const checkoutDir = await cyberbaseCheckout();
  await initializeAttempt({
    attemptId: 'OD-01',
    profile: 'owner-self-dogfood',
    checkoutDir,
    sourcePath: 'docs/guide.md',
    publicUrl: 'https://cybersader.github.io/cyberbase/guide/',
    sourceAuthorization: 'yes',
    projectRoot: PROJECT_ROOT,
    workspaceRoot: workspaceRootValue,
  });
  return {
    workspaceRoot: workspaceRootValue,
    paths: attemptPaths('OD-01', {
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspaceRootValue,
    }),
  };
}

function onlineStatus(overrides = {}) {
  const { Self: selfOverrides = {}, ...statusOverrides } = overrides;
  return JSON.stringify({
    BackendState: 'Running',
    ...statusOverrides,
    Self: {
      Online: true,
      DNSName: 'desktop.example-tailnet.ts.net.',
      TailscaleIPs: ['100.64.0.42', 'fd7a:115c:a1e0::1:6924'],
      ...selfOverrides,
    },
  });
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('owner dogfood reader snapshot', () => {
  test('loads one declared immutable form snapshot', async () => {
    const fixture = await initializedDogfood();
    const expected = await readFile(fixture.paths.readerForm);
    const snapshot = await loadDogfoodReaderSnapshot('OD-01', {
      projectRoot: PROJECT_ROOT,
      workspaceRoot: fixture.workspaceRoot,
    });

    expect(snapshot.bytes).toEqual(expected);
    expect(snapshot.byteLength).toBe(expected.byteLength);
    expect(snapshot.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(snapshot.bytes.toString('utf8')).toContain('Study instrument, not a product endpoint.');

    await writeFile(fixture.paths.readerForm, 'changed after startup', 'utf8');
    expect(snapshot.bytes).toEqual(expected);
  });

  test('rejects form bytes changed before the snapshot is loaded', async () => {
    const fixture = await initializedDogfood();
    await writeFile(
      fixture.paths.readerForm,
      '<!doctype html><script>fetch("https://example.invalid")</script>',
      'utf8',
    );
    await expect(loadDogfoodReaderSnapshot('OD-01', {
      projectRoot: PROJECT_ROOT,
      workspaceRoot: fixture.workspaceRoot,
    })).rejects.toMatchObject({ code: 'reader-form-integrity-mismatch' });
  });

  test('rejects non-dogfood and undeclared attempt IDs before serving', async () => {
    await expect(loadDogfoodReaderSnapshot('HC-01')).rejects.toMatchObject({
      code: 'dogfood-attempt-id-required',
    });
    const workspace = await workspaceRoot();
    await initializeOwnerDogfoodSeries({
      charter: dogfoodSeries(),
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    });
    await expect(loadDogfoodReaderSnapshot('OD-04', {
      projectRoot: PROJECT_ROOT,
      workspaceRoot: workspace,
    })).rejects.toMatchObject({ code: 'dogfood-attempt-not-declared' });
  });

  test('rejects symlinked, hard-linked, non-regular, and oversized form targets', async () => {
    const cases = ['symlink', 'hardlink', 'directory', 'oversized'];
    for (const kind of cases) {
      const fixture = await initializedDogfood();
      const replacement = `${fixture.paths.readerForm}.${kind}`;
      await rm(fixture.paths.readerForm);
      if (kind === 'symlink') {
        await writeFile(replacement, 'outside snapshot', 'utf8');
        await symlink(replacement, fixture.paths.readerForm, 'file');
      } else if (kind === 'hardlink') {
        await writeFile(replacement, 'linked snapshot', 'utf8');
        await link(replacement, fixture.paths.readerForm);
      } else if (kind === 'directory') {
        await mkdir(fixture.paths.readerForm);
      } else {
        await writeFile(fixture.paths.readerForm, Buffer.alloc(256 * 1024 + 1, 65));
      }
      await expect(loadDogfoodReaderSnapshot('OD-01', {
        projectRoot: PROJECT_ROOT,
        workspaceRoot: fixture.workspaceRoot,
      })).rejects.toBeTruthy();
    }
  });

  test('rejects an operator that no longer validates as the requested dogfood attempt', async () => {
    const fixture = await initializedDogfood();
    const operator = JSON.parse(await readFile(fixture.paths.operator, 'utf8'));
    operator.profile = 'cyberbase-rehearsal';
    await writeFile(fixture.paths.operator, `${JSON.stringify(operator)}\n`, 'utf8');
    await expect(loadDogfoodReaderSnapshot('OD-01', {
      projectRoot: PROJECT_ROOT,
      workspaceRoot: fixture.workspaceRoot,
    })).rejects.toBeTruthy();
  });
});

describe('exact reader HTTP contract', () => {
  const bytes = Buffer.from('<!doctype html><title>Private form</title>', 'utf8');
  const routePath = `/${'a'.repeat(43)}`;

  test('serves only exact GET and HEAD with restrictive headers', async () => {
    let served = 0;
    const handler = createDogfoodReaderHandler({
      bytes,
      routePath,
      allowedHostnames: ['100.64.0.42', 'desktop.example-tailnet.ts.net'],
      port: 48731,
      onServed: () => { served += 1; },
    });
    const get = await handler(new Request(`http://100.64.0.42:48731${routePath}`));
    expect(get.status).toBe(200);
    expect(Buffer.from(await get.arrayBuffer())).toEqual(bytes);
    expect(get.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(get.headers.get('cache-control')).toContain('no-store');
    expect(get.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(get.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const secondGet = await handler(new Request(`http://100.64.0.42:48731${routePath}`));
    expect(secondGet.status).toBe(404);
    await Promise.resolve();
    expect(served).toBe(1);

    const head = await handler(new Request(`http://desktop.example-tailnet.ts.net:48731${routePath}`, {
      method: 'HEAD',
    }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(served).toBe(1);
  });

  test('returns generic failures for every other route, host, query, and method', async () => {
    const handler = createDogfoodReaderHandler({
      bytes,
      routePath,
      allowedHostnames: ['100.64.0.42'],
      port: 48731,
    });
    for (const url of [
      'http://100.64.0.42:48731/',
      `http://100.64.0.42:48731${routePath}/`,
      `http://100.64.0.42:48731${routePath}?guess=true`,
      'http://100.64.0.42:48731/attempts/OD-01/reader-form.html',
      `http://127.0.0.1:48731${routePath}`,
      `http://100.64.0.42:48732${routePath}`,
    ]) {
      const response = await handler(new Request(url));
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not found\n');
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await handler(new Request(`http://100.64.0.42:48731${routePath}`, {
        method,
        body: 'private body must remain unread',
      }));
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
    }
    const guessedPost = await handler(new Request('http://100.64.0.42:48731/guessed', {
      method: 'POST',
      body: 'private body must remain unread',
    }));
    expect(guessedPost.status).toBe(404);
  });

  test('runs through a real loopback Bun server without exposing a directory', async () => {
    let handler;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      maxRequestBodySize: 1,
      fetch(request) { return handler(request); },
    });
    handler = createDogfoodReaderHandler({
      bytes,
      routePath,
      allowedHostnames: ['127.0.0.1'],
      port: server.port,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}${routePath}`);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
      expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(404);
    } finally {
      await server.stop(true);
    }
  });

  test('rejects raw GET and HEAD bodies without consuming the one-shot route', async () => {
    let handler;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      maxRequestBodySize: 1,
      fetch(request) { return handler(request); },
    });
    handler = createDogfoodReaderHandler({
      bytes,
      routePath,
      allowedHostnames: ['127.0.0.1'],
      port: server.port,
    });
    try {
      const getWithBody = await rawHttp(server.port,
        `GET ${routePath} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx`);
      expect(getWithBody).toMatch(/^HTTP\/1\.1 400 /u);

      const headWithBody = await rawHttp(server.port,
        `HEAD ${routePath} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n1\r\nx\r\n0\r\n\r\n`);
      expect(headWithBody).toMatch(/^HTTP\/1\.1 400 /u);

      const response = await fetch(`http://127.0.0.1:${server.port}${routePath}`);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      await server.stop(true);
    }
  });
});

describe('Tailscale discovery', () => {
  test('uses one read-only status command and validates the local address', async () => {
    const calls = [];
    const stdout = await runTailscaleStatusCommand({
      spawn(args, options) {
        calls.push({ args, options });
        return {
          stdout: new Blob([onlineStatus()]).stream(),
          stderr: new Blob([]).stream(),
          exited: Promise.resolve(0),
          kill() {},
        };
      },
    });
    const discovered = await discoverTailscaleSelf({ runStatus: async () => stdout });
    expect(calls.map((call) => call.args)).toEqual([['tailscale', 'status', '--json']]);
    expect(discovered).toEqual({
      ipv4: '100.64.0.42',
      dnsName: 'desktop.example-tailnet.ts.net',
    });
    expect(JSON.stringify(calls)).not.toMatch(/serve|funnel|reset|set-config|\bup\b/u);
  });

  test('fails closed when offline or given a non-Tailscale or duplicate IPv4', async () => {
    const values = [
      JSON.stringify({ BackendState: 'Stopped', Self: { Online: false, TailscaleIPs: [] } }),
      onlineStatus({ Self: { TailscaleIPs: ['192.168.1.25'] } }),
      onlineStatus({ Self: { TailscaleIPs: ['100.64.0.1', '100.64.0.2'] } }),
      '{not-json',
    ];
    for (const value of values) {
      await expect(discoverTailscaleSelf({ runStatus: async () => value })).rejects.toBeTruthy();
    }
  });

  test('treats an invalid MagicDNS name as optional display metadata', async () => {
    const discovered = await discoverTailscaleSelf({
      runStatus: async () => onlineStatus({ Self: { DNSName: 'not a host' } }),
    });
    expect(discovered).toEqual({ ipv4: '100.64.0.42', dnsName: null });
  });
});

describe('one-shot lifecycle and CLI', () => {
  test('stops exactly once after the first GET, expiry, or signals race', async () => {
    const signalSource = new EventEmitter();
    const timers = [];
    let stopCount = 0;
    let fetchHandler;
    const running = startDogfoodReaderServer({
      snapshot: { bytes: Buffer.from('form') },
      tailscale: { ipv4: '100.64.0.1', dnsName: 'node.example.ts.net' },
      expiresMinutes: 15,
      routeTokenFactory: () => 'a'.repeat(43),
      serverFactory(options) {
        expect(options.maxRequestBodySize).toBe(1);
        fetchHandler = options.fetch;
        return {
          port: 48731,
          stop() { stopCount += 1; },
        };
      },
      signalSource,
      setTimer(callback) {
        timers.push(callback);
        return timers.length;
      },
      clearTimer() {},
      now: () => 1_000,
      queueTask: (callback) => callback(),
    });

    const response = await fetchHandler(new Request(running.ipUrl));
    expect(await response.text()).toBe('form');
    signalSource.emit('SIGTERM');
    timers[0]();
    expect(await running.completion).toEqual({ reason: 'served' });
    expect(stopCount).toBe(1);
    expect(signalSource.listenerCount('SIGINT')).toBe(0);
    expect(signalSource.listenerCount('SIGTERM')).toBe(0);
  });

  test('closes the socket if lifecycle installation fails partway through startup', () => {
    const emitter = new EventEmitter();
    let stopCount = 0;
    const signalSource = {
      on(signal, handler) {
        if (signal === 'SIGTERM') throw new Error('injected signal failure');
        emitter.on(signal, handler);
      },
      off(signal, handler) { emitter.off(signal, handler); },
    };
    expect(() => startDogfoodReaderServer({
      snapshot: { bytes: Buffer.from('form') },
      tailscale: { ipv4: '100.64.0.1', dnsName: null },
      routeTokenFactory: () => 'a'.repeat(43),
      serverFactory() {
        return { port: 48731, stop() { stopCount += 1; } };
      },
      signalSource,
    })).toThrow('injected signal failure');
    expect(stopCount).toBe(1);
    expect(emitter.listenerCount('SIGINT')).toBe(0);
  });

  test('validates the bounded expiry without touching the network', () => {
    expect(parseExpiresMinutes()).toBe(15);
    expect(parseExpiresMinutes('1')).toBe(1);
    expect(parseExpiresMinutes('60')).toBe(60);
    for (const value of ['0', '-1', '1.5', '01', '61', 'forever']) {
      expect(() => parseExpiresMinutes(value)).toThrow();
    }
  });

  test('CLI rejects unsafe argument shapes before Tailscale discovery', async () => {
    const cwd = path.resolve(PROJECT_ROOT, 'spikes', 'human-correction-dry-run');
    const cases = [
      [],
      ['--attempt', 'HC-01'],
      ['--attempt', 'OD-01', '--expires-minutes', '0'],
      ['--attempt', 'OD-01', '--host', '0.0.0.0'],
      ['--attempt', 'OD-01', '--file', '/tmp/form.html'],
      ['--attempt', 'OD-01', '--attempt', 'OD-02'],
    ];
    for (const args of cases) {
      const result = await command(['bun', 'run', 'bin/dogfood-serve.js', ...args], cwd);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).not.toContain('http://');
    }
  });
});
