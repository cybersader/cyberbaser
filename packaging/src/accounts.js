// Which account each mode may run under. An installed setup records its two
// accounts in one root-owned file; without it (a container image or a
// developer machine) the modes still refuse root.
import { readFileSync } from 'node:fs';
import os from 'node:os';

export const INSTALL_RECORD = '/etc/cyberbaser/install.json';
export const DEFAULT_ACCOUNTS = Object.freeze({ node: 'cyberbaser', publisher: 'cyberbaser-publisher', group: 'cyberbaser-share' });

export function readInstallRecord(file = INSTALL_RECORD) {
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    if (record?.version !== 1 || typeof record.accounts?.node !== 'string' || typeof record.accounts?.publisher !== 'string') return null;
    return record;
  } catch {
    return null;
  }
}

function lookup(file, name) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    const fields = line.split(':');
    if (fields[0] === name && /^\d+$/u.test(fields[2] ?? '')) return { name, id: Number(fields[2]), fields };
  }
  return null;
}

export function userEntry(name, file = '/etc/passwd') { return lookup(file, name); }
export function groupEntry(name, file = '/etc/group') { return lookup(file, name); }

export function groupId(value) {
  if (/^\d+$/u.test(String(value))) return Number(value) > 0 ? Number(value) : null;
  return groupEntry(value)?.id ?? null;
}

// The account name for this process's uid, from the user database. Not from
// the environment: USER is unset in containers and can be set to anything.
export function accountName(uid, file = '/etc/passwd') {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    const fields = line.split(':');
    if (fields[2] === String(uid)) return fields[0];
  }
  return null;
}

export function currentAccount() {
  const uid = process.getuid?.() ?? -1;
  return { uid, name: accountName(uid) ?? os.userInfo().username };
}

/** Null when this mode may run here; otherwise one plain sentence. */
export function accountProblem(mode, { account = currentAccount(), record = readInstallRecord() } = {}) {
  if (!['node', 'setup', 'intake', 'publisher', 'pair'].includes(mode)) return null;
  if (account.uid === 0) return 'refuses to run as root; the installed service runs it under its own account.';
  if (record === null) return null;
  const { node, publisher } = record.accounts;
  if (['node', 'setup', 'intake'].includes(mode) && account.name !== node) return `runs only as the "${node}" account on this machine.`;
  if (mode === 'publisher' && account.name !== publisher) return `runs only as the "${publisher}" account on this machine.`;
  if (mode === 'pair' && (account.name === publisher || account.name === node)) return 'pairs an agent under your own account, not a service account.';
  return null;
}
