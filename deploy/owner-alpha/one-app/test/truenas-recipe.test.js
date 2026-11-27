import { expect, test } from 'bun:test';
import { LAYOUT } from '../../../../packaging/src/platform/linux-systemd.js';
import { CONTAINER_CONFIG } from '../../../../packaging/src/platform/container-config.js';
import path from 'node:path';

const root = new URL('../truenas/', import.meta.url);
const read = (name) => Bun.file(new URL(name, root)).text();
const { services } = Bun.YAML.parse(await read('compose.yaml'));
const rows = Object.fromEntries((await read('paths.tsv')).trim().split('\n').filter((line) => !line.startsWith('#')).map((line) => {
  const [rel, uid, gid, mode] = line.split(/\s+/u);
  return [rel, `${uid}:${gid}:${mode}`];
}));
const source = (v) => v.source.split('}/').at(-1);
const access = (role) => Object.fromEntries(role.volumes.map((v) => [v.target, `${source(v)}:${v.read_only ? 'ro' : 'rw'}`]));

test('TrueNAS app keeps the publisher off host networking and publishes no ports', () => {
  expect(Object.keys(services).sort()).toEqual(['config-reconciler', 'node', 'publisher']);
  expect(services.node.network_mode).toBe('host');
  expect(services.publisher.network_mode).toBeUndefined();
  expect(services.publisher.networks).toBeUndefined();
  expect(services['config-reconciler'].network_mode).toBe('none');
  for (const role of Object.values(services)) {
    expect(role.ports).toBeUndefined();
    expect(role.privileged).toBeUndefined();
    expect(role.init).toBe(true);
    expect(role.pull_policy).toBe('never');
    expect(role.read_only).toBe(true);
    expect(role.restart).toBe('unless-stopped');
    expect(role.cap_drop).toEqual(['ALL']);
    expect(role.security_opt).toEqual(['no-new-privileges:true']);
    expect(role.mem_limit).toBe(role.memswap_limit);
    expect(role.cpus).toBeGreaterThan(0);
    for (const v of role.volumes) {
      expect(v.type).toBe('bind');
      expect(v.bind.create_host_path).toBe(false);
      expect(rows[source(v)]).toBeDefined();
    }
  }
  expect(services.node.cap_add).toBeUndefined();
  expect(services.publisher.cap_add).toBeUndefined();
  expect(services['config-reconciler'].cap_add).toEqual(['CHOWN', 'DAC_OVERRIDE']);
});

test('TrueNAS host paths have precise owners and disjoint private-state mounts', () => {
  const { node, publisher, 'config-reconciler': reconciler } = services;
  const pubConfigDir = path.dirname(CONTAINER_CONFIG);
  const nodeConfigDir = path.dirname(LAYOUT.config);
  const workspace = `${LAYOUT.appRoot}/.workspace`;
  expect(access(node)).toEqual({ [LAYOUT.nodeHome]: 'node/state:rw', [nodeConfigDir]: 'node/config:rw',
    [workspace]: 'shared/workspace:rw', [LAYOUT.notes]: 'shared/notes:rw',
    [LAYOUT.mirrorParent]: 'shared/mirror:ro', [LAYOUT.publisherRun]: 'shared/publisher-sockets:ro' });
  expect(access(publisher)).toEqual({ [LAYOUT.publisherHome]: 'publisher/state:rw', [pubConfigDir]: 'publisher/config:ro',
    [workspace]: 'shared/workspace:rw', [LAYOUT.notes]: 'shared/notes:ro',
    [LAYOUT.mirrorParent]: 'shared/mirror:rw', [LAYOUT.publisherRun]: 'shared/publisher-sockets:rw' });
  expect(access(reconciler)).toEqual({ [nodeConfigDir]: 'node/config:ro', [pubConfigDir]: 'publisher/config:rw' });
  expect([node.user, publisher.user, reconciler.user]).toEqual(['65532:65530', '65533:65530', '0:0']);
  expect(rows).toEqual({ '.': '0:0:0700', node: '0:0:0700', publisher: '0:0:0700', shared: '0:0:0700',
    'node/state': '65532:65530:0700', 'node/config': '65532:65530:0700',
    'publisher/state': '65533:65530:0700', 'publisher/config': '65533:65530:0700',
    'shared/workspace': '65532:65530:0770', 'shared/notes': '65532:65530:0770',
    'shared/mirror': '65533:65530:0750', 'shared/publisher-sockets': '65533:65530:0710' });
});
