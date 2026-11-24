import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { UNIT_TEXTS } from '../src/units.js';
import { LAYOUT, nodeServiceArgs, publisherServiceMode } from '../src/platform/linux-systemd.js';

// The installed services choose their mode from what exists: setup until the
// node config (and the publisher's copy of it) exists, then the normal modes.

test.skipIf(existsSync(LAYOUT.publisherConfig) || existsSync(LAYOUT.config))('before setup: the publisher runs in setup mode with the mirror and notes copy', () => {
  const plan = publisherServiceMode({ version: 1, github: { clientId: 'Iv23liFAKEcyberbaser', origin: 'http://127.0.0.1:9' } });
  expect(plan).toEqual({
    mode: 'setup', socketPath: LAYOUT.publisherSocket, stateDirectory: LAYOUT.publisherForge, clientId: 'Iv23liFAKEcyberbaser',
    mirror: LAYOUT.mirror, checkout: `${LAYOUT.notes}/notes`, github: { clientId: 'Iv23liFAKEcyberbaser', origin: 'http://127.0.0.1:9' },
  });
  expect(publisherServiceMode(null).clientId).toBeNull();
  expect(nodeServiceArgs().mode).toBe('setup');
  // The mirror lives where the node can read it and only the publisher can write.
  expect(LAYOUT.mirror.startsWith(`${LAYOUT.shared}/`)).toBe(true);
});

test('the publisher unit always starts, in its own mode, and may write only its home and the mirror', () => {
  const unit = UNIT_TEXTS['cyberbaser-publisher.service'];
  expect(unit).not.toContain('ConditionPathExists');
  expect(unit).toContain('ExecStart=/opt/cyberbaser/bin/cyberbaser service-publisher');
  expect(unit).toContain('ReadWritePaths=/var/lib/cyberbaser-publisher /var/lib/cyberbaser-shared/mirror');
  expect(unit).toContain('InaccessiblePaths=-/var/lib/cyberbaser');
});
