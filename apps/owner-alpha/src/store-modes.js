// Creation modes for the job store.
//
// Default: owner-only (0700 directories, 0600 files). An installed setup runs
// the node and the publisher under two system accounts that share one group
// (the primary group of both services) and sets CYBERBASER_SHARED_STORE=group
// for both. Then, and only for the job records under `jobs/` (what the
// publisher reads, and where it adds its push receipt), directories are 0770
// and files 0640. The store root becomes traversable by the group (0710) so it
// can reach `jobs/`; every other store area stays owner-only, and the
// publisher's credentials and repository stay under its own account.
import path from 'node:path';

export const SHARED_STORE_ENV = 'CYBERBASER_SHARED_STORE';
const PRIVATE = Object.freeze({ directory: 0o700, file: 0o600 });
const TRAVERSE = Object.freeze({ directory: 0o710, file: 0o600 });
const SHARED = Object.freeze({ directory: 0o770, file: 0o640 });

export function storeModes(target, storeRoot, environment = process.env) {
  if (environment[SHARED_STORE_ENV] !== 'group' || typeof target !== 'string' || typeof storeRoot !== 'string') return PRIVATE;
  if (target === storeRoot) return TRAVERSE;
  const jobs = path.join(storeRoot, 'jobs');
  return target === jobs || target.startsWith(`${jobs}${path.sep}`) ? SHARED : PRIVATE;
}
