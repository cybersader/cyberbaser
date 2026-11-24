// Must be the first module the program evaluates. The build rewrites
// `import.meta.url` and `import.meta.main` in first-party modules to these two
// hooks, so a wrapped module finds its files at its installed location and a
// wrapped entry point runs its main block only when its mode selects it.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_APP_ROOT = '/opt/cyberbaser';

// The renderer's pinned seed path is a fixed constant under /opt/cyberbaser, so
// the installed root is fixed too. Only the test suite points elsewhere.
export function appRoot(environment = process.env) {
  const value = environment.CYBERBASER_APP_ROOT;
  return typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value
    ? value : DEFAULT_APP_ROOT;
}

// True inside the compiled program, false when run from source with bun.
export function isCompiled() {
  return typeof Bun !== 'undefined' && Bun.main.startsWith('/$bunfs/');
}

globalThis.__cyberbaserModuleUrl = (relativePath) => pathToFileURL(path.join(appRoot(), relativePath)).href;
globalThis.__cyberbaserEntry = null;
