// Linux install: two system accounts, owner-only state, hardened systemd units.
//
//   /opt/cyberbaser                    program and its read-only files (root)
//   /var/lib/cyberbaser                node only (config, Iroh keys, caches)      cyberbaser 0700
//   /var/lib/cyberbaser-shared         what the publisher may read                root:cyberbaser-share 0750
//     workspace/  job store, bound at /opt/cyberbaser/.workspace                  cyberbaser:cyberbaser-share 0770
//     notes/      the node's copy of the notes (Git checkout)                     cyberbaser:cyberbaser-share 0770
//     mirror/     the publisher's plain copy of the repository (bare Git):        cyberbaser-publisher:cyberbaser-share 0750
//                 the publisher alone fetches and writes it; the node reads it
//   /var/lib/cyberbaser-publisher      publisher only (forge key, push repo)      cyberbaser-publisher 0700
//     owners/   the owner keys that may approve a publish, the publisher's own
//               key and the one-time first-device code (signed publish).
//               Never copied from or to the node config.
//   /run/cyberbaser-publisher          publisher sockets, reachable by the group  0710
//
// Both services run with the share group as their primary group, so what the
// node shares is created in it (no set-group-ID directories). Private
// directories are mode 0700 whatever their group: neither account can read
// the other's.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, existsSync, lstatSync } from 'node:fs';
import { chown, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_ACCOUNTS, INSTALL_RECORD, groupEntry, readInstallRecord, userEntry } from '../accounts.js';

export const LAYOUT = Object.freeze({
  appRoot: '/opt/cyberbaser',
  program: '/opt/cyberbaser/bin/cyberbaser',
  libexec: '/opt/cyberbaser/libexec',
  recordDir: '/etc/cyberbaser',
  record: INSTALL_RECORD,
  nodeHome: '/var/lib/cyberbaser',
  shared: '/var/lib/cyberbaser-shared',
  workspace: '/var/lib/cyberbaser-shared/workspace',
  // First-run setup keeps its state owner-only; the notes copy it makes must
  // live in the shared directory so the publisher can read the commits.
  setup: '/var/lib/cyberbaser/setup',
  notes: '/var/lib/cyberbaser-shared/notes',
  mirrorParent: '/var/lib/cyberbaser-shared/mirror',
  mirror: '/var/lib/cyberbaser-shared/mirror/notes.git',
  publisherForge: '/var/lib/cyberbaser-publisher/forge',
  publisherOwners: '/var/lib/cyberbaser-publisher/owners',
  publisherHome: '/var/lib/cyberbaser-publisher',
  publisherRun: '/run/cyberbaser-publisher',
  publisherSocket: '/run/cyberbaser-publisher/publisher.sock',
  nodeRun: '/run/cyberbaser',
  config: '/var/lib/cyberbaser/config/owner-alpha.json',
  layoutFile: '/var/lib/cyberbaser/layout.json',
  publisherConfig: '/var/lib/cyberbaser-publisher/owner-alpha.json',
  unitDir: '/etc/systemd/system',
});

export const UNITS = Object.freeze(['cyberbaser-node.service', 'cyberbaser-publisher.service',
  'cyberbaser-config.path', 'cyberbaser-config-apply.service']);
const DEFAULT_PORT = 4317;
// The registered Cyberbaser GitHub App's public client ID. Not registered yet:
// until it is, install takes --github-client-id.
export const GITHUB_CLIENT_ID = null;
const ACCOUNTS = DEFAULT_ACCOUNTS;

function say(text) { process.stdout.write(`${text}\n`); }

function run(command, args, { allowFail = false, input } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', input });
  if (result.error || (result.status !== 0 && !allowFail)) {
    throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.error?.message || '').trim().slice(-300)}`);
  }
  return result;
}

function which(name) {
  for (const directory of ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin']) {
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function parse(args, known) {
  const options = { yes: false, dryRun: false, purge: false, seed: null, port: DEFAULT_PORT, clientId: null, githubOrigin: null, relay: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--yes' && known.includes(arg)) options.yes = true;
    else if (arg === '--dry-run' && known.includes(arg)) options.dryRun = true;
    else if (arg === '--purge' && known.includes(arg)) options.purge = true;
    else if (arg === '--quartz-seed' && known.includes(arg) && args[i + 1]) options.seed = path.resolve(args[++i]);
    else if (arg === '--port' && known.includes(arg) && /^\d{2,5}$/u.test(args[i + 1] ?? '')) options.port = Number(args[++i]);
    else if (arg === '--github-client-id' && known.includes(arg) && /^[A-Za-z0-9._-]{8,64}$/u.test(args[i + 1] ?? '')) options.clientId = args[++i];
    // GitHub Enterprise, or a stand-in GitHub for tests: the web and API origin.
    else if (arg === '--github-origin' && known.includes(arg) && /^https?:\/\/[A-Za-z0-9.:[\]-]+$/u.test(args[i + 1] ?? '')) options.githubOrigin = args[++i];
    else if (arg === '--iroh-relay' && known.includes(arg) && /^(none|n0|https:\/\/\S+|http:\/\/127\.0\.0\.1:\d{1,5}\/)$/u.test(args[i + 1] ?? '')) options.relay = args[++i];
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

// Ask for the admin password once, by re-running this same command as root.
function elevate(mode, args, programPath) {
  const graphical = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const pkexec = which('pkexec');
  const sudo = which('sudo');
  const tool = graphical && pkexec ? pkexec : sudo ?? pkexec;
  if (tool === null) {
    process.stderr.write('Cyberbaser needs administrator rights to install a background service, and neither pkexec nor sudo is available.\n');
    return 1;
  }
  say(`Cyberbaser needs the administrator password once to ${mode === 'install' ? 'install' : 'remove'} its background service (asking through ${path.basename(tool)}).`);
  const result = spawnSync(tool, [programPath, mode, ...args], { stdio: 'inherit' });
  return result.status ?? 1;
}

function exists(target) {
  try { lstatSync(target); return true; } catch { return false; }
}

/** What of ours, or of something else, is already on this machine. */
export function survey() {
  const record = readInstallRecord();
  const found = [];
  for (const target of [LAYOUT.appRoot, LAYOUT.nodeHome, LAYOUT.shared, LAYOUT.publisherHome]) if (exists(target)) found.push(target);
  for (const unit of UNITS) if (exists(path.join(LAYOUT.unitDir, unit))) found.push(path.join(LAYOUT.unitDir, unit));
  for (const name of [ACCOUNTS.node, ACCOUNTS.publisher]) if (userEntry(name)) found.push(`account ${name}`);
  if (groupEntry(ACCOUNTS.group)) found.push(`group ${ACCOUNTS.group}`);
  return { record, found };
}

async function ensureDirectory(target, { owner, group, mode }) {
  if (exists(target)) {
    const metadata = lstatSync(target);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${target} is not a real directory`);
  } else {
    await mkdir(target, { mode: 0o700 });
  }
  await chown(target, owner, group);
  // chmod(1), not fs.chmod: the set-group-ID bit must survive.
  run('chmod', [mode.toString(8), target]);
}

async function writeOwned(file, contents, { owner = 0, group = 0, mode = 0o644 } = {}) {
  const temporary = `${file}.tmp-${randomBytes(6).toString('hex')}`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(contents);
    await handle.chown(owner, group);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

async function unitTexts() {
  const { UNIT_TEXTS, HARDENING } = await import('../units.js');
  return Object.fromEntries(Object.entries(UNIT_TEXTS).map(([name, text]) => [name, text.replace('@HARDENING@', HARDENING.trim())]));
}

function nologin() {
  return ['/usr/sbin/nologin', '/sbin/nologin', '/bin/false'].find((candidate) => existsSync(candidate));
}

function ensureAccounts() {
  if (!groupEntry(ACCOUNTS.group)) run('groupadd', ['--system', ACCOUNTS.group]);
  const shell = nologin();
  for (const [name, home, comment] of [[ACCOUNTS.node, LAYOUT.nodeHome, 'Cyberbaser node'],
    [ACCOUNTS.publisher, LAYOUT.publisherHome, 'Cyberbaser publisher']]) {
    if (!userEntry(name)) {
      run('useradd', ['--system', '--user-group', '--no-create-home', '--home-dir', home, '--shell', shell, '--comment', comment, name]);
    }
    run('usermod', ['--append', '--groups', ACCOUNTS.group, name]);
  }
  return {
    node: userEntry(ACCOUNTS.node).id,
    nodeGroup: groupEntry(ACCOUNTS.node).id,
    publisher: userEntry(ACCOUNTS.publisher).id,
    publisherGroup: groupEntry(ACCOUNTS.publisher).id,
    share: groupEntry(ACCOUNTS.group).id,
  };
}

// Build the new program tree beside the old one, then swap it in whole.
async function installProgram(programPath, seed) {
  const fresh = `${LAYOUT.appRoot}.new-${randomBytes(4).toString('hex')}`;
  const previous = `${LAYOUT.appRoot}.old-${randomBytes(4).toString('hex')}`;
  await mkdir(fresh, { mode: 0o755 });
  try {
    const { RESOURCES_TAR } = await import('../resources.js');
    const tarball = path.join(fresh, '.resources.tar');
    await writeFile(tarball, Buffer.from(await Bun.file(RESOURCES_TAR).arrayBuffer()), { mode: 0o600 });
    run('tar', ['--no-same-owner', '-C', fresh, '-xf', tarball]);
    await rm(tarball);
    for (const directory of ['bin', 'libexec', '.workspace', 'vendor']) await mkdir(path.join(fresh, directory), { mode: 0o755 });
    await writeFile(path.join(fresh, 'bin', 'cyberbaser'), Buffer.from(await Bun.file(programPath).arrayBuffer()), { mode: 0o755 });
    // The renderer scripts call `node` and `bun`; both are this program's own runtime.
    for (const name of ['node', 'bun']) {
      await writeFile(path.join(fresh, 'libexec', name), `#!/bin/sh\nBUN_BE_BUN=1 exec ${LAYOUT.program} "$@"\n`, { mode: 0o755 });
    }
    // The node checks its store is Git-ignored inside its project root.
    run('git', ['init', '-q', fresh]);
    let seedNote;
    if (seed !== null) {
      const { unpackSeed } = await import('../quartz-seed.js');
      const staging = path.join(fresh, 'vendor', 'quartz');
      await mkdir(staging, { mode: 0o755 });
      await unpackSeed(seed, staging);
      seedNote = 'renderer bundle installed and verified';
    } else if (exists(path.join(LAYOUT.appRoot, 'vendor', 'quartz'))) {
      await rename(path.join(LAYOUT.appRoot, 'vendor', 'quartz'), path.join(fresh, 'vendor', 'quartz'));
      seedNote = 'renderer bundle kept';
    } else {
      seedNote = 'renderer bundle missing: the private site cannot build until you run install again with --quartz-seed <file>';
    }
    run('chmod', ['-R', 'a+rX,go-w', fresh]);
    if (exists(LAYOUT.appRoot)) await rename(LAYOUT.appRoot, previous);
    await rename(fresh, LAYOUT.appRoot);
    await rm(previous, { recursive: true, force: true });
    return seedNote;
  } catch (error) {
    await rm(fresh, { recursive: true, force: true });
    throw error;
  }
}

async function installState(ids, { port, clientId, relay }) {
  // The node's checks expect its directories in its own (primary) group.
  await ensureDirectory(LAYOUT.nodeHome, { owner: ids.node, group: ids.share, mode: 0o700 });
  for (const name of ['home', 'cache', 'config', 'iroh', 'setup']) {
    await ensureDirectory(path.join(LAYOUT.nodeHome, name), { owner: ids.node, group: ids.share, mode: 0o700 });
  }
  // The program and renderer files belong to root; Git refuses to read a
  // repository owned by someone else unless the account marks it safe. The
  // renderer passes only HOME through, so this lives in the node's own config.
  const gitconfig = path.join(LAYOUT.nodeHome, 'home', '.gitconfig');
  const asNode = (args) => run('setpriv', ['--reuid', String(ids.node), '--regid', String(ids.share), '--clear-groups',
    '--', 'git', 'config', '--file', gitconfig, ...args], { allowFail: true });
  const safe = (asNode(['--get-all', 'safe.directory']).stdout ?? '').split('\n');
  for (const directory of [LAYOUT.appRoot, path.join(LAYOUT.appRoot, 'vendor', 'quartz'), LAYOUT.mirror]) {
    if (!safe.includes(directory) && asNode(['--add', 'safe.directory', directory]).status !== 0) {
      throw new Error('could not write the node account Git settings');
    }
  }
  await ensureDirectory(LAYOUT.shared, { owner: 0, group: ids.share, mode: 0o750 });
  await ensureDirectory(LAYOUT.workspace, { owner: ids.node, group: ids.share, mode: 0o770 });
  // The path to the job records, made now so nothing can create it owner-only
  // first: traversable by the group down to jobs/, which the group shares.
  for (const [relative, mode] of [['owner-alpha', 0o710], ['owner-alpha/store', 0o710], ['owner-alpha/store/jobs', 0o770]]) {
    const target = path.join(LAYOUT.workspace, relative);
    if (!exists(target)) await ensureDirectory(target, { owner: ids.node, group: ids.share, mode });
  }
  await ensureDirectory(LAYOUT.notes, { owner: ids.node, group: ids.share, mode: 0o770 });
  // Written by the publisher only; the node reads it through the share group.
  await ensureDirectory(LAYOUT.mirrorParent, { owner: ids.publisher, group: ids.share, mode: 0o750 });
  await ensureDirectory(LAYOUT.publisherHome, { owner: ids.publisher, group: ids.publisherGroup, mode: 0o700 });
  // What first-run setup needs to write the node config (see bin/cyberbaser-setup.js).
  const layout = {
    listen: { host: '127.0.0.1', port },
    reviewSocket: path.join(LAYOUT.nodeRun, 'review.sock'),
    irohStateDirectory: path.join(LAYOUT.nodeHome, 'iroh'),
    forgeStateDirectory: path.join(LAYOUT.publisherHome, 'forge'),
    configFile: LAYOUT.config,
    // Where the notes copy must go so the publisher can read it (see the design page).
    checkout: path.join(LAYOUT.notes, 'notes'),
    // The publisher's copy of the repository the node copies from and reads the remote branch in.
    mirror: LAYOUT.mirror,
    clientId,
    ...(relay ? { relay } : {}),
  };
  // Rewritten on each install (it holds no secret), so an update brings new fields.
  await writeOwned(LAYOUT.layoutFile, `${JSON.stringify(layout, null, 2)}\n`, { owner: ids.node, group: ids.share, mode: 0o600 });
}

async function writeRecord(record) {
  await mkdir(LAYOUT.recordDir, { recursive: true, mode: 0o755 });
  await writeOwned(LAYOUT.record, `${JSON.stringify(record, null, 2)}\n`);
}

function systemctl(...args) { return run('systemctl', args, { allowFail: true }); }

// The publisher's loopback page for the first-device code: the node's port + 2.
export function enrollPagePort(port) { return port + 2; }

// Signed publish: as the publisher account, open the first-device window and
// make the recovery code, then print both here, on the administrator's
// terminal. The node never sees them.
function printEnrollment(ids, port) {
  const result = spawnSync('setpriv', ['--reuid', String(ids.publisher), '--regid', String(ids.share), '--clear-groups', '--',
    LAYOUT.program, 'publisher', 'enroll-code'], { stdio: ['ignore', 'inherit', 'inherit'],
    env: { PATH: '/usr/bin:/bin', HOME: LAYOUT.publisherHome } });
  if (result.status !== 0) {
    say('The publishing setup code could not be made; run "cyberbaser publisher enroll-code" as administrator.');
    return;
  }
  say(`The same code is shown on this computer at http://127.0.0.1:${enrollPagePort(port)}/enroll (not to the web app).`);
}

function setupLink(since) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const log = run('journalctl', ['--unit', 'cyberbaser-node.service', '--since', since, '--output', 'cat', '--no-pager'], { allowFail: true }).stdout ?? '';
    const lines = log.split('\n').filter((line) => line.startsWith('Cyberbaser setup: '));
    if (lines.length > 0) return lines.at(-1).slice('Cyberbaser setup: '.length);
    Bun.sleepSync(500);
  }
  return null;
}

function plan(options) {
  return [
    `create system accounts "${ACCOUNTS.node}" (node and intake) and "${ACCOUNTS.publisher}" (publisher), and the group "${ACCOUNTS.group}"`,
    `install the program and its files in ${LAYOUT.appRoot}${options.seed ? ' with the verified renderer bundle' : ''}`,
    `create owner-only state in ${LAYOUT.nodeHome} and ${LAYOUT.publisherHome}, and the shared job store, notes copy and publisher mirror in ${LAYOUT.shared}`,
    `install the services ${UNITS.join(', ')} in ${LAYOUT.unitDir}, then enable and start them`,
  ];
}

export async function install(args, { programPath, compiled }) {
  let options;
  try { options = parse(args, ['--yes', '--dry-run', '--quartz-seed', '--port', '--github-client-id', '--github-origin', '--iroh-relay']); }
  catch (error) { process.stderr.write(`${error.message}\n`); return 2; }
  if (options.dryRun) {
    say('cyberbaser install would:');
    for (const step of plan(options)) say(`  - ${step}`);
    return 0;
  }
  if (!compiled) { process.stderr.write('Install runs from the built program (bun packaging/build.js).\n'); return 1; }
  if (process.getuid() !== 0) return elevate('install', args, programPath);
  if (!exists('/run/systemd/system')) { process.stderr.write('This machine does not run systemd; use the container image instead.\n'); return 1; }
  const missing = ['systemctl', 'journalctl', 'useradd', 'groupadd', 'usermod', 'git', 'flock', 'rsync', 'bash', 'tar',
    ...(options.seed ? ['zstd'] : [])].filter((name) => which(name) === null);
  if (missing.length > 0) { process.stderr.write(`Missing programs: ${missing.join(', ')}. Install them and try again.\n`); return 1; }
  if (options.seed !== null && !exists(options.seed)) { process.stderr.write(`No renderer bundle at ${options.seed}.\n`); return 1; }

  const { record, found } = survey();
  if (record === null && found.length > 0) {
    process.stderr.write(`Found an existing setup this installer did not make, so nothing was changed:\n${found.map((item) => `  - ${item}`).join('\n')}\n`);
    return 1;
  }
  const clientId = options.clientId ?? record?.github?.clientId ?? GITHUB_CLIENT_ID;
  if (clientId === null) {
    process.stderr.write('The Cyberbaser GitHub App is not registered yet. Run install with --github-client-id <the app client ID>.\n');
    return 1;
  }
  const githubOrigin = options.githubOrigin ?? record?.github?.origin ?? null;
  const relay = options.relay ?? record?.irohRelay ?? null;
  const updating = record?.state === 'installed';
  const since = new Date().toISOString().replace('T', ' ').slice(0, 19);
  if (updating) systemctl('stop', ...UNITS);
  const ids = ensureAccounts();
  const seedNote = await installProgram(programPath, options.seed);
  await installState(ids, { port: options.port, clientId, relay });
  const units = await unitTexts();
  for (const [name, text] of Object.entries(units)) await writeOwned(path.join(LAYOUT.unitDir, name), text);
  await writeRecord({ version: 1, state: 'installed', accounts: { node: ACCOUNTS.node, publisher: ACCOUNTS.publisher },
    group: ACCOUNTS.group, appRoot: LAYOUT.appRoot, port: options.port,
    github: { clientId, ...(githubOrigin ? { origin: githubOrigin } : {}) }, ...(relay ? { irohRelay: relay } : {}), installedAt: record?.installedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString() });
  systemctl('daemon-reload');
  printEnrollment(ids, options.port);
  const enabled = systemctl('enable', '--now', 'cyberbaser-node.service', 'cyberbaser-config.path');
  // The publisher runs from the start: in setup mode (sign-in, repository
  // choice, the mirror, the starter publish.yml) until the node config exists.
  systemctl('enable', '--now', 'cyberbaser-publisher.service');
  if (enabled.status !== 0) { process.stderr.write('The services were installed but did not start; see: journalctl -u cyberbaser-node\n'); return 1; }
  say(`Installed (${seedNote}).`);
  if (exists(LAYOUT.config)) {
    say(`Cyberbaser is running: http://127.0.0.1:${options.port}/`);
    return 0;
  }
  const link = setupLink(since);
  say(link === null ? 'The node is starting; run "cyberbaser status" for the setup address.' : `Open this to finish setup: ${link}`);
  return 0;
}

export async function uninstall(args, { programPath }) {
  let options;
  try { options = parse(args, ['--yes', '--dry-run', '--purge']); }
  catch (error) { process.stderr.write(`${error.message}\n`); return 2; }
  if (options.dryRun) {
    say(`cyberbaser uninstall would stop and remove the services and ${LAYOUT.appRoot}${options.purge
      ? `, then delete all Cyberbaser data and the accounts` : `, and keep your data in ${LAYOUT.nodeHome}, ${LAYOUT.shared} and ${LAYOUT.publisherHome}`}.`);
    return 0;
  }
  if (process.getuid() !== 0) return elevate('uninstall', args, programPath);
  const { record, found } = survey();
  if (record === null) {
    if (found.length === 0) { say('Cyberbaser is not installed.'); return 0; }
    process.stderr.write(`Found a setup this installer did not make, so nothing was removed:\n${found.map((item) => `  - ${item}`).join('\n')}\n`);
    return 1;
  }
  systemctl('disable', '--now', ...UNITS);
  for (const unit of UNITS) await rm(path.join(LAYOUT.unitDir, unit), { force: true });
  systemctl('daemon-reload');
  await rm(LAYOUT.appRoot, { recursive: true, force: true });
  if (options.purge) {
    for (const target of [LAYOUT.nodeHome, LAYOUT.shared, LAYOUT.publisherHome]) await rm(target, { recursive: true, force: true });
    for (const name of [ACCOUNTS.publisher, ACCOUNTS.node]) if (userEntry(name)) run('userdel', [name], { allowFail: true });
    if (groupEntry(ACCOUNTS.group)) run('groupdel', [ACCOUNTS.group], { allowFail: true });
    await rm(LAYOUT.recordDir, { recursive: true, force: true });
    say('Cyberbaser and all its data were removed.');
  } else {
    await writeRecord({ ...record, state: 'removed', removedAt: new Date().toISOString() });
    say(`Cyberbaser was removed. Your data and its two accounts are kept in ${LAYOUT.nodeHome}, ${LAYOUT.shared} and ${LAYOUT.publisherHome}; "cyberbaser uninstall --purge" deletes them.`);
  }
  return 0;
}

export async function status() {
  const { record, found } = survey();
  if (record === null) {
    say(found.length === 0 ? 'Cyberbaser is not installed.' : `Not installed by this program, but found: ${found.join(', ')}`);
    return found.length === 0 ? 0 : 1;
  }
  say(`Cyberbaser ${record.state === 'installed' ? 'installed' : 'removed (data kept)'} in ${record.appRoot}`);
  say(`Accounts: node "${record.accounts.node}", publisher "${record.accounts.publisher}", group "${record.group}"`);
  for (const unit of UNITS) {
    const state = run('systemctl', ['is-active', unit], { allowFail: true }).stdout.trim() || 'unknown';
    say(`  ${unit}: ${state}`);
  }
  if (record.state === 'installed') {
    say(existsSync(LAYOUT.config) || process.getuid() !== 0
      ? `Address: http://127.0.0.1:${record.port}/`
      : `Setup not finished: ${setupLink('-1h') ?? `http://127.0.0.1:${record.port}/setup`}`);
  }
  return 0;
}

// Internal: the node service entry. First-run setup until the config exists.
export function nodeServiceArgs() {
  return existsSync(LAYOUT.config)
    ? { mode: 'node', args: [LAYOUT.config] }
    : { mode: 'setup', args: [LAYOUT.setup, String(readInstallRecord()?.port ?? DEFAULT_PORT), LAYOUT.publisherSocket, LAYOUT.layoutFile] };
}

// Internal: the installed publisher service. Setup mode (no push, sign-in,
// mirror and the one starter file) until its copy of the node config exists;
// then the normal publisher. The config path unit restarts it when setup ends.
export function publisherServiceMode(record = readInstallRecord()) {
  const github = record?.github ?? {};
  // Signed publish: where the owner keys live (never from the config copy) and the first-device page port.
  const signed = { owners: LAYOUT.publisherOwners, enrollPort: enrollPagePort(record?.port ?? DEFAULT_PORT) };
  if (existsSync(LAYOUT.publisherConfig)) {
    return { mode: 'publisher', configFile: LAYOUT.publisherConfig, socketPath: LAYOUT.publisherSocket,
      repository: path.join(LAYOUT.publisherHome, 'push.git'), github, ...signed };
  }
  return { mode: 'setup', socketPath: LAYOUT.publisherSocket, stateDirectory: LAYOUT.publisherForge, clientId: github.clientId ?? null,
    mirror: LAYOUT.mirror, checkout: path.join(LAYOUT.notes, 'notes'), github, ...signed };
}

export async function runPublisherService({ appRoot }) {
  const plan = publisherServiceMode();
  const { groupId } = await import('../accounts.js');
  const socketGroup = groupId(ACCOUNTS.group);
  const { createGithubHttp } = await import('../../../apps/owner-alpha/src/publisher/forge-access.js');
  const http = plan.github.origin ? createGithubHttp({ apiBaseUrl: plan.github.origin, webBaseUrl: plan.github.origin }) : undefined;
  const publisherCli = await import('../../../apps/owner-alpha/bin/owner-alpha-publisher.js');
  // Signed publish, enforced: the owner-key list is the publisher's own state.
  const owners = { directory: plan.owners, mode: 'enforce', enrollPort: plan.enrollPort, nodeUid: userEntry(ACCOUNTS.node)?.id ?? null };
  if (plan.mode === 'publisher') {
    await publisherCli.runPublisherCli({ configFile: plan.configFile, socketPath: plan.socketPath, repository: plan.repository,
      projectRoot: appRoot, socketGroup, owners, ...(http ? { forgeOptions: { http } } : {}) });
    return 0;
  }
  if (!plan.clientId) { process.stderr.write('No GitHub App client ID in the install record\n'); return 1; }
  await publisherCli.runSetupForgeCli({ socketPath: plan.socketPath, stateDirectory: plan.stateDirectory, clientId: plan.clientId,
    mirror: plan.mirror, checkout: plan.checkout, socketGroup, http, owners });
  return 0;
}

// Internal, root, before the publisher starts: copy the node config into the
// publisher's own owner-only file. The source must be one regular file owned
// by the node account; it is never followed through a link. No node config
// yet means setup: there is nothing to copy and the publisher runs in setup mode.
export async function syncPublisherConfig() {
  if (process.getuid() !== 0) { process.stderr.write('sync-publisher-config runs as root from the publisher service\n'); return 1; }
  const node = userEntry(ACCOUNTS.node);
  const publisher = userEntry(ACCOUNTS.publisher);
  const share = groupEntry(ACCOUNTS.group);
  if (!node || !publisher || !share) { process.stderr.write('Cyberbaser accounts are missing\n'); return 1; }
  if (!exists(LAYOUT.config)) {
    await rm(LAYOUT.publisherConfig, { force: true });
    return 0;
  }
  let handle;
  try {
    handle = await open(LAYOUT.config, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== node.id || (metadata.mode & 0o077) !== 0
      || metadata.size > 1024 * 1024) throw new Error('node config is not one private regular file of the node account');
    const text = await handle.readFile('utf8');
    JSON.parse(text);
    await writeOwned(LAYOUT.publisherConfig, text, { owner: publisher.id, group: share.id, mode: 0o600 });
    return 0;
  } catch (error) {
    process.stderr.write(`publisher config not copied: ${error.message}\n`);
    return 1;
  } finally {
    await handle?.close();
  }
}

