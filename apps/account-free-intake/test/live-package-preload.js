// file: installs may be cached copies. Keep compatibility tests on this worktree.
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
const packages = new Map([
  ['@cyberbaser/proposal', '../../../packages/proposal/src/index.js'],
  ['@cyberbaser/proposal/v2', '../../../packages/proposal/src/v2.js'],
  ['@cyberbaser/account-free-intake', '../../../packages/account-free-intake/src/index.js'],
  ['@cyberbaser/proposal-queue', '../../../packages/proposal-queue/src/index.js'],
  ['@cyberbaser/proposal-review', '../../../packages/proposal-review/src/index.js'],
]);
plugin({
  name: 'account-free-live-worktree-packages',
  setup(build) {
    build.onResolve({ filter: /^@cyberbaser\/(?:proposal(?:\/v2)?|account-free-intake|proposal-queue|proposal-review)$/u }, ({ path }) => ({
      path: fileURLToPath(new URL(packages.get(path), import.meta.url)),
    }));
  },
});
