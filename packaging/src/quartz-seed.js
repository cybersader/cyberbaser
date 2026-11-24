// The site builder's offline seed: the pinned Quartz checkout with its locked
// npm dependencies installed, packed once into one archive whose SHA-256 the
// program pins. Installing verifies the archive digest before unpacking, then
// the renderer's own setup verifies the checkout (origin, tag, commit, lock).
// Rendering never fetches anything: the private build is offline.
//
//   bun packaging/src/quartz-seed.js pack <verified-seed-dir> <out.tar.zst>
//   bun packaging/src/quartz-seed.js digest <archive>
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const QUARTZ_SEED = Object.freeze({
  ref: 'v4.5.2',
  commit: '4923affa7722dfc751f1074348e6dad214fe0c08',
  lockSha256: '9ea5873a2bb495054f23b16f96d1d41f44348863e655f4c6d86b107f372b09b9',
  installSha256: '38bc51071b55a4444abdea3e0620747882e2be3a8610da5715a9c0b40b320850',
  // SHA-256 of the archive produced by `pack` from a verified seed (2026-11-23).
  archiveSha256: 'd563d041a997d717a32dadde4633c90f9a089b0c1b602da0673bc5394f1f06f2',
  directory: 'vendor/quartz',
});

const TAR_FLAGS = ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--format=gnu'];

export async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || '').trim().slice(-400)}`);
  return result.stdout.trim();
}

export function verifySeedCheckout(directory) {
  const git = (...args) => run('git', ['-C', directory, '-c', `safe.directory=${directory}`, ...args]);
  if (git('rev-parse', 'HEAD') !== QUARTZ_SEED.commit) throw new Error('seed is not at the pinned Quartz commit');
  if (git('describe', '--tags', '--exact-match') !== QUARTZ_SEED.ref) throw new Error('seed is not at the pinned Quartz tag');
  if (git('status', '--porcelain', '--untracked-files=normal') !== '') throw new Error('seed checkout has local changes');
  const lock = run('sha256sum', [path.join(directory, 'package-lock.json')]).split(' ')[0];
  if (lock !== QUARTZ_SEED.lockSha256) throw new Error('seed lockfile does not match the pin');
  const marker = run('cat', [path.join(directory, 'node_modules', '.cyberbaser-install-sha256')]);
  if (marker !== QUARTZ_SEED.installSha256) throw new Error('seed dependencies were not installed from the pinned lock');
}

export function packSeed(directory, archive) {
  verifySeedCheckout(directory);
  const tar = spawnSync('tar', [...TAR_FLAGS, '-C', directory, '--exclude=./quartz/.quartz-cache', '-c', '.'], { maxBuffer: 2 ** 31 });
  if (tar.status !== 0) throw new Error('tar failed');
  run('zstd', ['-q', '-19', '-T0', '-f', '-o', archive], { input: tar.stdout, maxBuffer: 2 ** 31 });
}

/** Verify the archive digest, then unpack it into an empty staging directory. */
export async function unpackSeed(archive, staging) {
  const digest = await fileSha256(archive);
  if (digest !== QUARTZ_SEED.archiveSha256) throw new Error('the renderer bundle does not match the pinned digest');
  run('tar', ['--zstd', '--no-same-owner', '-C', staging, '-xf', archive]);
  verifySeedCheckout(staging);
  return digest;
}

if (import.meta.main) {
  const [command, first, second] = process.argv.slice(2);
  if (command === 'pack' && first && second) {
    packSeed(path.resolve(first), path.resolve(second));
    console.log(`${await fileSha256(path.resolve(second))}  ${second}`);
  } else if (command === 'digest' && first) {
    console.log(await fileSha256(path.resolve(first)));
  } else {
    console.error('usage: quartz-seed.js pack <seed-dir> <out.tar.zst> | digest <archive>');
    process.exit(2);
  }
}
