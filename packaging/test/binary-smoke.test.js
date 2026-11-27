// The compiled program: every mode answers --help, and the node starts from a
// synthetic config with no network at all, builds its private site with the
// program's own runtime, starts the suggestion intake through the program,
// opens an Iroh endpoint with no relay, and answers its reader health check.
//
// The node part needs the pinned renderer bundle unpacked somewhere:
//   CYBERBASER_QUARTZ_SEED_DIR=/path/to/verified/seed bun test packaging/test/binary-smoke.test.js
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const REPO = path.resolve(import.meta.dir, '..', '..');
const SEED = process.env.CYBERBASER_QUARTZ_SEED_DIR ?? null;
const NAMESPACE = path.join(import.meta.dir, 'in-namespace.sh');
const PORT = 47610;
let program; let scratch;

function run(args, options = {}) {
  return spawnSync(program, args, { encoding: 'utf8', timeout: 20_000, ...options });
}

beforeAll(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'cyberbaser-smoke-'));
  program = path.join(scratch, 'cyberbaser');
  // Built by the real build script, exactly as a release would be.
  const built = spawnSync(process.execPath, [path.join(REPO, 'packaging', 'build.js'), '--outfile', program], { encoding: 'utf8' });
  if (built.status !== 0) throw new Error(built.stderr);
}, 120_000);

afterAll(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

test('every mode answers --help from an empty directory', () => {
  const empty = path.join(scratch, 'empty');
  spawnSync('mkdir', [empty]);
  const main = run(['--help'], { cwd: empty });
  expect(main.status).toBe(0);
  for (const mode of ['node', 'publisher', 'intake', 'pair', 'install', 'uninstall', 'status']) {
    expect(main.stdout).toContain(`  ${mode}`);
    const one = run([mode, '--help'], { cwd: empty });
    expect(one.status).toBe(0);
    expect(one.stdout).toMatch(new RegExp(`^Usage: cyberbaser ${mode}`, 'u'));
  }
  expect(run(['version']).stdout).toMatch(/^cyberbaser \d+\.\d+\.\d+ \(bun-linux-x64\)\n$/u);
  expect(run(['nonsense']).status).toBe(2);
  expect(run(['install', '--dry-run']).stdout).toContain('create system accounts "cyberbaser"');
});

test('the Iroh addon is inside the program: pairing loads it with no files beside the program', () => {
  const result = run(['pair', 'not-a-code'], { cwd: path.join(scratch, 'empty') });
  expect(result.stderr.trim()).toBe('invalid-pairing-code');
});

async function prepareAppRoot() {
  const root = path.join(scratch, 'app');
  await mkdir(root);
  expect(spawnSync('tar', ['-xf', path.join(REPO, 'packaging', 'dist', 'resources.tar'), '-C', root]).status).toBe(0);
  for (const directory of ['bin', 'libexec', '.workspace', 'vendor/quartz']) await mkdir(path.join(root, directory), { recursive: true });
  spawnSync('cp', [program, path.join(root, 'bin', 'cyberbaser')]);
  await copyFile(path.join(REPO, 'packaging', 'dist', 'render-offline'), path.join(root, 'libexec', 'render-offline'));
  for (const name of ['node', 'bun']) {
    await writeFile(path.join(root, 'libexec', name), '#!/bin/sh\nBUN_BE_BUN=1 exec /opt/cyberbaser/bin/cyberbaser "$@"\n', { mode: 0o755 });
  }
  spawnSync('git', ['init', '-q', root]);
  return root;
}

async function syntheticVault(home) {
  const vault = path.join(home, 'vault');
  await mkdir(path.join(vault, '.cyberbaser'), { recursive: true });
  await writeFile(path.join(vault, 'index.md'), '# Smoke notes\n\nA synthetic page. See [[second]].\n');
  await writeFile(path.join(vault, 'second.md'), '# Second\n\nAnother synthetic page.\n');
  await writeFile(path.join(vault, 'publish.yml'), 'allow:\n  - "*.md"\n');
  await writeFile(path.join(vault, '.cyberbaser/trust.yml'), 'trusted: [smoke]\nagents: []\n');
  const git = (...args) => expect(spawnSync('git', ['-C', vault, ...args]).status).toBe(0);
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.name', 'Smoke');
  git('config', 'user.email', 'smoke@example.invalid');
  git('add', '-A');
  git('commit', '-qm', 'synthetic');
  git('remote', 'add', 'origin', 'https://github.com/smoke/notes.git');
  // Offline, the forge is a local bare repository. The node's startup check
  // asks the remote for its branch head, so only that lookup is redirected.
  const remote = path.join(home, 'remote.git');
  expect(spawnSync('git', ['init', '-q', '--bare', '--initial-branch=main', remote]).status).toBe(0);
  expect(spawnSync('git', ['-C', vault, 'push', '-q', remote, 'main']).status).toBe(0);
  await mkdir(path.join(home, 'shim'));
  await writeFile(path.join(home, 'shim', 'git'), `#!/bin/bash
args=("$@"); transport=0
for a in "$@"; do [ "$a" = ls-remote ] && transport=1; done
if [ $transport = 1 ]; then for i in "\${!args[@]}"; do [ "\${args[$i]}" = origin ] && args[$i]=${remote}; done
  exec /usr/bin/git -c protocol.file.allow=always "\${args[@]}"; fi
exec /usr/bin/git "$@"
`, { mode: 0o755 });
  return vault;
}

test.skipIf(SEED === null)('the node starts offline from the program, renders, starts the intake and Iroh, and is healthy', async () => {
  const root = await prepareAppRoot();
  const home = path.join(scratch, 'home');
  await mkdir(home, { mode: 0o700 });
  const vault = await syntheticVault(home);
  await mkdir(path.join(home, 'iroh'), { mode: 0o700 });
  await mkdir(path.join(home, 'run'), { mode: 0o700 });
  const config = {
    schemaVersion: 1, listen: { host: '127.0.0.1', port: PORT, readerPort: PORT + 1 },
    repository: { checkout: vault, remote: { name: 'origin', url: 'https://github.com/smoke/notes.git' }, branch: 'main' },
    owner: { identity: 'smoke', allowedTrustRoutes: ['auto-merge', 'quick-review'] },
    live: { baseUrl: 'https://smoke.github.io/notes/' },
    workflow: { provider: 'github-actions', repository: 'smoke/notes', name: 'Publish', path: '.github/workflows/publish.yml',
      event: 'push', branch: 'main', jobs: ['build', 'deploy'], environment: 'github-pages' },
    proposalReview: { enabled: true, socketPath: path.join(home, 'run', 'review.sock'), requestTimeoutMs: 5000, maxListEntries: 100 },
    workspace: { root: '.workspace/owner-alpha', store: '.workspace/owner-alpha/store', site: '.workspace/owner-alpha/site', cache: '.workspace/owner-alpha/cache' },
    paths: { include: ['*.md'], exclude: ['.git/**', '.workspace/**', '.cyberbaser/**'] },
    limits: { maxSourceBytes: 65536, maxReplacementBytes: 65536, maxChangedBytes: 65536, maxChangedLines: 60,
      maxArtifactBytes: 8388608, requestTimeoutMs: 30000, networkTimeoutMs: 900000 },
    checks: { allowedOfmVerdicts: ['clean'], requirePublishedSource: true, requireProjectionVerification: true,
      requireNoNewBrokenLinks: true, requireRenderedWitness: true },
    git: { autoCommit: true, autoPush: false, useHooks: false, commitMessagePrefix: 'smoke:' },
    suggestions: { form: { enabled: true }, forge: { enabled: false } },
    iroh: { enabled: true, stateDirectory: path.join(home, 'iroh'), relay: 'none', bindAddress: '127.0.0.1:0' },
  };
  const configFile = path.join(home, 'owner.json');
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  // One script inside the namespace: start the node, wait for health, show the
  // node's UDP sockets (the Iroh endpoint), stop the node.
  const probe = path.join(home, 'probe.sh');
  await writeFile(probe, `#!/bin/sh
set -u
export PATH=${home}/shim:/opt/cyberbaser/libexec:/usr/bin:/bin HOME=${home}
start=$(date +%s%N)
/opt/cyberbaser/bin/cyberbaser node ${configFile} > ${home}/node.log 2>&1 &
pid=$!
for i in $(seq 1 600); do
  if curl -fsS -o /dev/null -H 'Host: 127.0.0.1:${PORT + 1}' http://127.0.0.1:${PORT + 1}/cyberbase/; then
    echo "healthy_ms=$(( ($(date +%s%N) - start) / 1000000 ))"; break
  fi
  kill -0 $pid 2>/dev/null || { echo node-exited; break; }
  sleep 0.2
done
sleep 1
echo "network_interfaces=$(ip -o link show | awk -F': ' '{print $2}' | tr '\\n' ' ')"
echo "intake_children=$(pgrep -P $pid -c || true)"
echo "udp_sockets=$(ss -Hlun | wc -l)"
kill $pid; wait $pid
echo "exit=$?"
`, { mode: 0o755 });
  const child = spawn(NAMESPACE, [root, SEED, String(process.getuid()), String(process.getgid()), '--', probe], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  const log = await Bun.file(path.join(home, 'node.log')).text().catch(() => '');
  console.log(output.trim());
  if (!/healthy_ms=/u.test(output)) console.log(log);
  expect(code, `${output}\n${log}`).toBe(0);
  expect(output).toMatch(/healthy_ms=\d+/u);
  expect(output).toContain('network_interfaces=lo ');
  expect(output).toMatch(/intake_children=[1-9]/u);
  // The Iroh endpoint is the only UDP user in this namespace (no relay, loopback only).
  expect(output).toMatch(/udp_sockets=[1-9]/u);
  expect(log).toContain('Owner alpha reader: http://127.0.0.1:');
  expect(log).toContain('Suggestions: form on');
  expect(await readdir(path.join(home, 'iroh'))).not.toHaveLength(0);
  await delay(10);
}, 300_000);
