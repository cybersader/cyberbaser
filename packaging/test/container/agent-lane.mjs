// Test scaffolding, run as the node account: register one synthetic agent key
// for the local signed socket and prepare its read-only snapshot and capture.
//   BUN_BE_BUN=1 cyberbaser agent-lane.mjs <config> <agent-dir> <note path> <old text> <new text>
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateKey } from '/src/apps/owner-alpha/bin/owner-alpha-keys.js';

const [configFile, agentDir, notePath, oldText, newText] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configFile, 'utf8'));
mkdirSync(agentDir, { mode: 0o700 });
const entry = await generateKey({ label: 'Synthetic test agent', kind: 'agent', grants: ['propose'], file: path.join(agentDir, 'key.json') });
const registry = path.join(path.dirname(configFile), 'registry.json');
writeFileSync(registry, JSON.stringify({ ownerId: config.owner.identity, entries: [entry] }), { mode: 0o600 });
const git = (...args) => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args[0]} ${result.stderr}`);
  return result.stdout.trim();
};
const snapshot = path.join(agentDir, 'snapshot');
git('clone', '-q', '--no-hardlinks', '--', config.repository.checkout, snapshot);
git('-C', snapshot, 'remote', 'remove', 'origin');
git('-C', snapshot, 'config', '--local', 'cyberbaser.repository', config.repository.remote.url);
const base = readFileSync(path.join(snapshot, notePath), 'utf8');
if (!base.includes(oldText)) throw new Error('old text missing');
writeFileSync(path.join(agentDir, 'capture.json'), JSON.stringify({ source: 'synthetic-agent', path: notePath, text: base.replace(oldText, newText) }), { mode: 0o600 });
// Test-only: the stand-in GitHub has no Actions, so a pushed job's deployment
// check can only time out; a shorter wait keeps the test moving.
const wait = Number(process.env.CB_TEST_NETWORK_TIMEOUT_MS ?? 0);
const next = { ...config, deviceRegistryFile: registry, signedRequestSocket: '/run/cyberbaser/signed.sock',
  ...(wait > 0 ? { limits: { ...config.limits, networkTimeoutMs: wait } } : {}) };
writeFileSync(`${configFile}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
renameSync(`${configFile}.tmp`, configFile);
process.stdout.write(`${JSON.stringify({ keyId: entry.keyId })}\n`);
