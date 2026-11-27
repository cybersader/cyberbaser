// Keeping the node's notes copy current without a forge credential.
//
// With a publisher mirror (config.publisher.mirror), the node asks the
// publisher to fetch from GitHub, then fast-forwards its own clean checkout
// from the mirror, a local read. When GitHub cannot be reached the node still
// starts and serves from the copy it has, and says so quietly.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateOwnerAlphaConfig } from './config.js';
import { forgeRequest } from './publisher/forge-control.js';

const exec = promisify(execFile);
const OID = /^[0-9a-f]{40}$/u;
export const UPSTREAM_REFRESH_TIMEOUT_MS = 20_000;

function cleanEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };
}

/** Git in the node's checkout, allowed to read only the one mirror path. */
export function mirrorGit(mirror) {
  return async (cwd, args) => {
    const { stdout } = await exec('git', ['-C', cwd, '-c', `safe.directory=${mirror}`, '-c', 'protocol.allow=never',
      '-c', 'protocol.file.allow=always', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...args],
    { env: cleanEnv(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 });
    return String(stdout).trim();
  };
}

/** The mirror's head for one branch, or null. No network. */
export async function mirrorHead(mirror, branch, cwd, git = mirrorGit(mirror)) {
  const output = await git(cwd, ['ls-remote', '--refs', '--', mirror, `refs/heads/${branch}`]).catch(() => '');
  const match = /^([0-9a-f]{40})\trefs\/heads\/(\S+)$/u.exec(output);
  return match && match[2] === branch ? match[1] : null;
}

/**
 * Fast-forward a clean checkout on the configured branch to the mirror's head.
 * Never rewrites local work: a dirty, diverged or ahead checkout is left as is.
 */
export async function syncCheckoutFromMirror(configInput, { git } = {}) {
  const config = validateOwnerAlphaConfig(configInput);
  const mirror = config.publisher?.mirror;
  if (!mirror) return { state: 'no-mirror' };
  const run = git ?? mirrorGit(mirror);
  const { checkout } = config.repository;
  const branch = config.repository.branch;
  try {
    const target = await mirrorHead(mirror, branch, checkout, run);
    if (target === null) return { state: 'mirror-empty' };
    const head = await run(checkout, ['rev-parse', 'HEAD']);
    if (!OID.test(head)) return { state: 'checkout-unreadable' };
    if (head === target) return { state: 'current', head };
    if (await run(checkout, ['symbolic-ref', '--quiet', '--short', 'HEAD']) !== branch) return { state: 'off-branch', head };
    if (await run(checkout, ['status', '--porcelain=v1', '--untracked-files=all']) !== '') return { state: 'local-changes', head };
    await run(checkout, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--', mirror,
      `+refs/heads/${branch}:refs/remotes/${config.repository.remote.name}/${branch}`]);
    const ahead = await run(checkout, ['merge-base', '--is-ancestor', head, target]).then(() => false, () => true);
    if (ahead) return { state: 'diverged', head };
    await run(checkout, ['merge', '--ff-only', '--quiet', target]);
    return { state: 'updated', head: target, from: head };
  } catch {
    return { state: 'sync-failed' };
  }
}

/**
 * The upstream status the node shows. refresh() asks the publisher to fetch,
 * then syncs the checkout; it never throws.
 */
export function createUpstream({ config: configInput, request = forgeRequest, sync = syncCheckoutFromMirror, timeoutMs = UPSTREAM_REFRESH_TIMEOUT_MS,
  clock = () => new Date(), restartAttempts = 8, restartWaitMs = 1500 }) {
  const config = validateOwnerAlphaConfig(configInput);
  let status = { state: 'unknown', checkedAt: null };
  return Object.freeze({
    current: () => ({ ...status }),
    // sync: false only asks (for a periodic check while jobs may be running);
    // the checkout is moved only at startup, before anything else touches it.
    async refresh({ sync: moveCheckout = true } = {}) {
      if (!config.publisher?.mirror) return this.current();
      let reachable = false;
      // The publisher may be restarting (it does when the config changes): wait for it briefly.
      for (let attempt = 0; attempt < restartAttempts; attempt += 1) {
        try {
          const held = await request({ socketPath: config.publisher.socketPath, op: 'fetch', timeoutMs });
          reachable = OID.test(held?.head ?? '');
          break;
        } catch (error) {
          if (error?.code !== 'publisher-unavailable' || attempt === restartAttempts - 1) break;
          await new Promise((resolve) => { setTimeout(resolve, restartWaitMs); });
        }
      }
      const synced = moveCheckout ? await sync(config) : { state: status.checkout ?? 'not-checked' };
      status = { state: reachable ? 'reachable' : 'unreachable', checkedAt: clock().toISOString(), checkout: synced.state };
      return this.current();
    },
  });
}
