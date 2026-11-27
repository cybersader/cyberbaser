import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { validateConfig as validateIntakeConfig } from '../../account-free-intake/src/config.js';
import { configInput as intakeInput } from '../../account-free-intake/test/helpers.js';
import { validateOwnerAlphaConfig } from '../src/config.js';
import { ownerConfigFromSetup } from '../src/first-run.js';
import { upstreamNotice } from '../src/server.js';
import { parseStarterPublishYml, starterPublishYml, validStarterFolder } from '../src/starter-publish.js';
import { agentLaneEnabled, deriveIntakeConfig } from '../src/suggestions.js';
import { createUpstream } from '../src/upstream.js';

// Units behind the installed one-app setup: the starter publish.yml the
// publisher accepts, the mirror in the node config, the quiet GitHub state,
// and the intake that runs for paired agents.

const example = JSON.parse(await readFile(new URL('../owner-alpha.example.json', import.meta.url), 'utf8'));

test('a starter publish.yml is recognized only byte for byte', () => {
  const text = starterPublishYml(['Garden', 'Journal']);
  expect(parseStarterPublishYml(Buffer.from(text))).toEqual(['Garden', 'Journal']);
  expect(parseStarterPublishYml(Buffer.from(starterPublishYml([])))).toEqual([]);
  for (const bad of [
    starterPublishYml(['Journal', 'Garden']), // not sorted
    starterPublishYml(['Garden', 'Garden']),
    starterPublishYml(['.github']),
    starterPublishYml(['a/b']),
    text.replace('Garden/**', '**'),
    `${text}\n`,
    text.replace(/\n$/u, ''),
    'allow:\n  - "Garden/**"\n',
    text.replace('allow:', 'allow: # all'),
  ]) expect(parseStarterPublishYml(Buffer.from(bad))).toBeNull();
  expect(parseStarterPublishYml(Buffer.from([0xff, 0xfe]))).toBeNull();
  expect(validStarterFolder('node_modules')).toBe(false);
  expect(validStarterFolder('Notes 2026')).toBe(true);
});

test('the node config may name the publisher mirror; setup writes it, with the relay', () => {
  const raw = structuredClone(example);
  raw.repository.checkout = '/srv/notes';
  raw.publisher = { socketPath: '/run/p/publisher.sock', mirror: '/var/lib/shared/mirror/notes.git' };
  expect(validateOwnerAlphaConfig(raw).publisher.mirror).toBe('/var/lib/shared/mirror/notes.git');
  for (const mirror of ['relative/x.git', '/x.git', '/a/b/../c.git', '/a/b/', 7]) {
    raw.publisher.mirror = mirror;
    expect(() => validateOwnerAlphaConfig(raw)).toThrow();
  }
  const setup = { v: 1, step: 'done', repository: 'cybersader/cyberbase', completedAt: 'x', website: {}, notes: { branch: 'main', detected: null } };
  const { config } = ownerConfigFromSetup(setup, {
    listen: { host: '127.0.0.1', port: 4317 }, reviewSocket: '/run/cyberbaser/review.sock', irohStateDirectory: '/var/lib/cyberbaser/iroh',
    forgeStateDirectory: '/var/lib/cyberbaser-publisher/forge', clientId: 'Iv23liFAKEcyberbaser', configFile: '/x', checkout: '/srv/notes',
    publisherSocket: '/run/p/publisher.sock', mirror: '/var/lib/shared/mirror/notes.git', relay: 'none',
  });
  expect(config.publisher).toEqual({ socketPath: '/run/p/publisher.sock', mirror: '/var/lib/shared/mirror/notes.git' });
  expect(config.iroh.relay).toBe('none');
  // Paired agents propose through the intake, so it runs for them with the form off.
  expect(agentLaneEnabled(config)).toBe(true);
  const intake = deriveIntakeConfig(config, '/opt/cyberbaser');
  expect(intake).toMatchObject({ listen: null, publicOrigin: null, allowedFormOrigins: [], reviewIpc: { enabled: true } });
  expect(() => validateIntakeConfig(structuredClone(intake))).not.toThrow();
});

test('the intake may run for its review socket alone, never with no input at all', () => {
  const root = '/srv/intake';
  const agentsOnly = intakeInput(root, { listen: null, publicOrigin: null, allowedFormOrigins: [],
    reviewIpc: { enabled: true, socketPath: '/run/x/review.sock', requestTimeoutMs: 5000, maxConcurrentRequests: 4, maxListEntries: 100 } });
  expect(validateIntakeConfig(agentsOnly).listen).toBeNull();
  expect(() => validateIntakeConfig(intakeInput(root, { listen: null, publicOrigin: null, allowedFormOrigins: [] }))).toThrow(/listen may be null only/);
});

test('GitHub unreachable is a quiet state, not a failure', async () => {
  const raw = structuredClone(example);
  raw.repository.checkout = '/srv/notes';
  raw.publisher = { socketPath: '/run/p/publisher.sock', mirror: '/var/lib/shared/mirror/notes.git' };
  let reachable = false;
  const upstream = createUpstream({ config: raw, sync: async () => ({ state: 'current' }),
    request: async () => { if (!reachable) throw Object.assign(new Error('down'), { code: 'github-unreachable' }); return { head: 'a'.repeat(40) }; } });
  expect(upstream.current().state).toBe('unknown');
  expect(upstreamNotice(upstream)).toBe('');
  expect(await upstream.refresh()).toMatchObject({ state: 'unreachable', checkout: 'current' });
  expect(upstreamNotice(upstream)).toContain('Can&#39;t reach GitHub'.replace('&#39;', "'"));
  reachable = true;
  expect(await upstream.refresh()).toMatchObject({ state: 'reachable' });
  expect(upstreamNotice(upstream)).toBe('');
  expect(upstreamNotice(null)).toBe('');
});
