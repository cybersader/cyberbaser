// Opt-in: the Linux install in a disposable systemd container (rootless Podman).
//   CYBERBASER_CONTAINER_TEST=1 CYBERBASER_QUARTZ_SEED_ARCHIVE=/path/quartz-seed-v4.5.2.tar.zst \
//     bun test packaging/test/container-install.test.js
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ENABLED = process.env.CYBERBASER_CONTAINER_TEST === '1' && Boolean(process.env.CYBERBASER_QUARTZ_SEED_ARCHIVE);

test.skipIf(!ENABLED)('install, isolation, one cross-account push, uninstall, reinstall, refusal', () => {
  const run = spawnSync('bash', [path.join(import.meta.dir, 'container', 'run.sh')], { encoding: 'utf8', timeout: 900_000 });
  const output = `${run.stdout}${run.stderr}`;
  console.log(output.split('\n').filter((line) => /^(FAIL|RESULT|install_ms)/u.test(line)).join('\n'));
  expect(output).toMatch(/RESULT pass=\d+ fail=0/u);
  expect(run.status).toBe(0);
}, 900_000);
