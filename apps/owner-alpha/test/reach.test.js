import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { EndpointTicket } from '@number0/iroh';
import { validateIroh } from '../src/config.js';
import { resolveReach } from '../src/core/reach.js';
import { irohConfigFromLayout } from '../src/first-run.js';
import { bindIrohNode, startIrohCarrier } from '../src/iroh-carrier.js';
import { checkReachConformance } from './reach-conformance.js';

const base = { enabled: true, stateDirectory: '/var/lib/cb-iroh', relay: 'none' };

test('reach defaults to direct and resolves a neutral ingress policy', () => {
  expect(validateIroh(base).reach).toBe('direct');
  expect(resolveReach()).toEqual({ mode: 'direct', ipv4: null });
  expect(resolveReach('relay-only')).toEqual({ mode: 'relay-only', ipv4: '127.0.0.1' });
  for (const ipv4 of ['10.20.30.40', '100.64.0.1', '100.127.255.254', '127.0.0.1', '172.31.5.6', '192.168.1.20']) {
    const reach = `private-address:${ipv4}`;
    expect(resolveReach(reach)).toEqual({ mode: 'private-address', ipv4 });
    expect(validateIroh({ ...base, reach }).reach).toBe(reach);
  }
});

test('reach rejects public, wildcard, malformed and ambiguous settings', () => {
  for (const reach of [null, false, {}, 'Direct', 'relay-only\n', 'direct:10.1.1.1', 'private-address',
    ...['', '8.8.8.8', '100.63.0.1', '100.128.0.1', '172.32.1.2', '169.254.1.1', '0.0.0.0',
      '127.0.0.1:4444', '127.0.0.1\n', '127.0.0.01', '127.1', '::1', '10.1.1.1/24', '192.168.1.256']
      .map((address) => `private-address:${address}`)]) {
    expect(() => validateIroh({ ...base, reach })).toThrow('$.iroh.reach');
  }
  const legacy = validateIroh({ ...base, bindAddress: '127.0.0.1:0' });
  expect(legacy.bindAddress).toBe('127.0.0.1:0');
  expect(legacy).not.toHaveProperty('reach');
  expect(validateIroh(legacy)).toEqual(legacy);
  expect(() => validateIroh({ ...legacy, reach: 'relay-only' })).toThrow('cannot be used together');
});

test('setup uses normalized node carrier settings and rejects a malformed layout', () => {
  const layout = { irohStateDirectory: base.stateDirectory, relay: 'none', reach: 'relay-only' };
  expect(irohConfigFromLayout(layout)).toEqual(validateIroh({ ...base, reach: 'relay-only' }));
  expect(irohConfigFromLayout({ irohStateDirectory: base.stateDirectory }).reach).toBe('direct');
  expect(() => irohConfigFromLayout({ ...layout, reach: 'private-address:0.0.0.0' })).toThrow();
});

const assigned = new Set(Object.values(networkInterfaces()).flat().map(({ address }) => address));
const absentIPv4 = ['192.168.254.253', '10.254.253.252', '172.31.253.252'].find((address) => !assigned.has(address));
checkReachConformance('Iroh', async (reach) => {
  const binding = await bindIrohNode({ secretKey: randomBytes(32), config: validateIroh({ ...base, reach }) });
  const carrier = startIrohCarrier(binding);
  return { sockets: binding.endpoint.boundSockets(),
    advertisedDirect: EndpointTicket.fromString(carrier.ticket).endpointAddr().directAddresses(), close: carrier.close };
}, { localIPv4: process.platform === 'linux' ? '127.0.0.2' : '127.0.0.1', absentIPv4 });

test('native installer validates reach even in a dry run, without inspecting installed state', () => {
  const cli = fileURLToPath(new URL('../../../packaging/src/cli.js', import.meta.url));
  const dryRun = (...flags) => Bun.spawnSync([process.execPath, cli, 'install', '--dry-run', ...flags]);
  const valid = dryRun('--reach', 'relay-only');
  expect(valid.exitCode).toBe(0);
  expect(valid.stdout.toString()).toContain('phone and agent reach to relay-only');
  for (const flags of [['--reach'], ['--reach', 'private-address:0.0.0.0'], ['--reach', 'direct', '--reach', 'relay-only']]) {
    expect(dryRun(...flags).exitCode).toBe(2);
  }
});
