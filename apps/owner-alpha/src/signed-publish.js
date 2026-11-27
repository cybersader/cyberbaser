// Node side of signed publish: describe a committed job as the body of a
// publish intent, so a device can show it and sign it.
//
// This description carries no authority. A device must compute the change
// hashes from the bytes it shows the owner and compare them with this body
// before signing; the publisher then checks the commit against the signed
// intent from its own copy of the Git objects (approval-gate.js).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256Hex } from '../../../packages/signed-intent/src/index.js';
import { fail } from './errors.js';

const exec = promisify(execFile);
const RAW = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) [ADM]$/u;
const PERSON = /^(.+) <([^<>]+)> (\d+) ([+-]\d{4})$/u;

export function gitIn(repository) {
  return async (args) => {
    const { stdout } = await exec('git', ['-C', repository, '-c', 'core.hooksPath=/dev/null', ...args],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    return Buffer.from(stdout);
  };
}

function person(line, header) {
  const match = PERSON.exec(line.slice(header.length + 1));
  if (!line.startsWith(`${header} `) || match === null) fail('commit-unreadable', 'commit author or committer is unreadable');
  return { name: match[1], email: match[2], time: Number(match[3]), tz: match[4] };
}

/** { target, base, commit, changes } for one single-parent commit. */
export async function describePublish({ git, commit, remote, branch }) {
  const raw = await git(['cat-file', 'commit', commit]);
  const boundary = raw.indexOf('\n\n');
  if (boundary < 0) fail('commit-unreadable', 'commit is unreadable');
  const headers = raw.subarray(0, boundary).toString('utf8').split('\n');
  if (headers.length !== 4 || !/^tree [0-9a-f]{40}$/u.test(headers[0]) || !/^parent [0-9a-f]{40}$/u.test(headers[1])) {
    fail('commit-unreadable', 'only a plain single-parent commit can be signed');
  }
  const base = headers[1].slice(7);
  const diff = (await git(['diff-tree', '-r', '-z', '--no-renames', '--no-commit-id', '--raw', base, commit])).toString('utf8').split('\0');
  if (diff.at(-1) === '') diff.pop();
  const side = async (mode, id) => (mode === '000000' ? null : { mode, sha256: sha256Hex(await git(['cat-file', 'blob', id])) });
  const changes = [];
  for (let i = 0; i < diff.length; i += 2) {
    const match = RAW.exec(diff[i]);
    if (match === null) fail('commit-unreadable', 'the commit changes something other than plain files');
    changes.push({ path: diff[i + 1], before: await side(match[1], match[3]), after: await side(match[2], match[4]) });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    target: { remote, branch },
    base,
    commit: { author: person(headers[2], 'author'), committer: person(headers[3], 'committer'), message: raw.subarray(boundary + 2).toString('utf8') },
    changes,
  };
}

/** A complete unsigned intent from a challenge, a key ID and a description. */
export function publishIntent({ challenge, keyId, description }) {
  return { v: 1, kind: 'publish', publisher: challenge.publisher, keyId, nonce: challenge.nonce,
    issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt, ...description };
}
