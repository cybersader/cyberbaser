import { expect, test } from 'bun:test';
import { LAYOUT, enrollPagePort } from '../../../../packaging/src/platform/linux-systemd.js';
import { DEFAULT_ACCOUNTS } from '../../../../packaging/src/accounts.js';

const dir = new URL('../', import.meta.url);
const read = (name) => Bun.file(new URL(name, dir)).text();
const compose = Bun.YAML.parse(await read('compose.yaml'));
const install = JSON.parse(await read('install.json'));
const init = await read('container-init.sh');
const image = await read('Containerfile');

test('one-app uses the native paths, default ports and distinct service roles', () => {
  expect(install).toEqual({ version: 1, state: 'container', appRoot: LAYOUT.appRoot, port: 4317,
    accounts: { node: DEFAULT_ACCOUNTS.node, publisher: DEFAULT_ACCOUNTS.publisher },
    group: DEFAULT_ACCOUNTS.group, publication: 'private-site', reach: 'direct' });
  expect(enrollPagePort(install.port)).toBe(4319);
  const { node, publisher } = compose.services;
  expect(node.command).toEqual(['service-node']);
  expect(publisher.command).toEqual(['service-publisher']);
  expect([node.user, publisher.user]).toEqual(['65532:65530', '65533:65530']);
  expect(publisher.network_mode).toBe('service:node');
  expect(node.network_mode).toBe('none');
  expect(compose.services['volumes-init'].command).toEqual(['init-volumes']);
  expect(init).toContain('service-node) umask 0007;');
  expect(init).toContain('service-publisher) umask 0027;');
  for (const path of [LAYOUT.config, LAYOUT.mirror, LAYOUT.publisherForge, `${LAYOUT.nodeRun}/review.sock`]) {
    expect(init).toContain(`"${path}"`);
  }
  expect(image).toContain(`safe.directory ${LAYOUT.mirror}`);
});

test('the opt-in lab has no published ports, writable root or cross-mounted private state', () => {
  const { node, publisher } = compose.services;
  for (const role of [node, publisher]) {
    expect(role.read_only).toBe(true);
    expect(role.cap_drop).toEqual(['ALL']);
    expect(role.security_opt).toEqual(['no-new-privileges:true']);
    expect(role.ports).toBeUndefined();
    expect(role.profiles).toEqual(['manual-lab']);
    expect(role.logging).toEqual({ driver: 'none' });
    expect(role.volumes.every((v) => v.type === 'volume' && v.volume.nocopy)).toBe(true);
  }
  const access = (role) => Object.fromEntries(role.volumes.map((v) => [v.target, v.read_only ? 'ro' : 'rw']));
  const common = { [`${LAYOUT.appRoot}/.workspace`]: 'rw' };
  expect(access(node)).toEqual({ ...common, [LAYOUT.nodeHome]: 'rw', [LAYOUT.notes]: 'rw',
    [LAYOUT.mirrorParent]: 'ro', [LAYOUT.publisherRun]: 'ro' });
  expect(access(publisher)).toEqual({ ...common, [LAYOUT.publisherHome]: 'rw', [LAYOUT.notes]: 'ro',
    [LAYOUT.mirrorParent]: 'rw', [LAYOUT.publisherRun]: 'rw' });
});
