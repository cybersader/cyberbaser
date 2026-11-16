// Compatibility tests must exercise this worktree, not Bun's cached file: copy.
// Use: bun test --preload ./packages/proposal/test/live-package-preload.js <suites>
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';

const entries = new Map([
  ['@cyberbaser/proposal', '../src/index.js'],
  ['@cyberbaser/proposal/v2', '../src/v2.js'],
  ['@cyberbaser/proposal/schema/v1', '../schema/proposal-v1.schema.json'],
  ['@cyberbaser/proposal/schema/v2', '../schema/proposal-v2.schema.json'],
]);
plugin({
  name: 'proposal-live-worktree-compatibility',
  setup(build) {
    build.onResolve({ filter: /^@cyberbaser\/proposal(?:\/(?:v2|schema\/v[12]))?$/u }, ({ path }) => ({
      path: fileURLToPath(new URL(entries.get(path), import.meta.url)),
    }));
  },
});
