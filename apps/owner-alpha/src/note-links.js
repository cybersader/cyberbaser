// Linking a note in the owner's writing tool to its file in the vault.
//
// A phone's first Send of a note the node cannot place (no file at the same
// path in the vault, or the publication page not yet bound) leaves a request
// here, in memory, for the owner. On the node's Devices page the owner sees the
// path the device reported, picks the vault path (same path by default, from
// the published paths), and confirms. The link is recorded only when the two
// texts match after line-ending folding; otherwise the owner is told how many
// lines differ and nothing is recorded. Devices have no route to this.
//
// Records: one owner-only JSON file outside the vault, replaced atomically.
import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { OwnerAlphaError } from './errors.js';
import { foldWorkspaceText, publicationDigest } from './owner-publication.js';
import { pathMatchesPolicy } from './source.js';
import { countDifferentLines } from './note-status.js';

const MAX_REQUESTS = 8;
const REQUEST_TTL_MS = 30 * 60_000;
const MAX_LINKS = 2000;
const MAX_FILE_BYTES = 1024 * 1024;
const FILE_NAME = 'note-links.json';

export function validNotePath(value) {
  return typeof value === 'string' && Buffer.byteLength(value) <= 1024 && value.endsWith('.md')
    && !value.split('/').some((part) => !part || part === '.' || part === '..') && !/[\\\p{Cc}\p{Cs}]/u.test(value);
}

async function readLinks(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || info.size > MAX_FILE_BYTES) {
      throw new Error('note links file must be a small owner-only file');
    }
    const value = JSON.parse(await handle.readFile('utf8'));
    if (value?.schemaVersion !== 1 || typeof value.links !== 'object' || value.links === null) throw new Error('note links schema');
    const links = new Map();
    for (const [notePath, link] of Object.entries(value.links)) {
      if (!validNotePath(notePath) || !validNotePath(link?.vaultPath) || typeof link.foldedTextDigest !== 'string'
        || typeof link.commit !== 'string' || typeof link.linkedAt !== 'string') throw new Error('note link record');
      links.set(notePath, Object.freeze({ vaultPath: link.vaultPath, commit: link.commit,
        foldedTextDigest: link.foldedTextDigest, linkedAt: link.linkedAt }));
    }
    return links;
  } finally { await handle.close(); }
}

async function writeLinks(file, links) {
  const temporary = path.join(path.dirname(file), `.tmp-links-${randomUUID()}`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, links: Object.fromEntries(links) })}\n`, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  try { await rename(temporary, file); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

function refusal(code) {
  return new OwnerAlphaError(code, 'note link refused');
}

// noteStatus: createNoteStatus(); mapping: the configured publication mapping
// (or null); publication: the runtime, for bindWorkspaceBaseline; readMappingNote:
// the node's own reader for the mapping's workspace copy.
export async function openNoteLinks({ directory, config, noteStatus, publication = null, readMappingNote = null,
  clock = Date.now }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('note links need an absolute directory');
  const info = await lstat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error('note links directory must be owner-only');
  const file = path.join(directory, FILE_NAME);
  let links = await readLinks(file);
  const requests = new Map(); // requestId -> { notePath, text, mappingId, at }
  const mapping = config.ownerPublication?.enabled ? config.ownerPublication.mappings[0] : null;
  let queue = Promise.resolve();
  const serial = (task) => { const next = queue.then(task, task); queue = next.catch(() => {}); return next; };

  const expire = () => {
    const now = clock();
    for (const [id, request] of requests) if (now - request.at > REQUEST_TTL_MS) requests.delete(id);
  };
  const isMappingNote = (notePath) => mapping !== null && mapping.source.path === notePath;

  return Object.freeze({
    // Vault path for a workspace path, or null when the owner linked nothing.
    resolve(notePath) {
      return links.get(notePath)?.vaultPath ?? null;
    },

    // A device's Send hit an unplaceable note: keep one request per path.
    request({ notePath, text = null }) {
      if (!validNotePath(notePath)) return null;
      expire();
      for (const [id, request] of requests) if (request.notePath === notePath) requests.delete(id);
      while (requests.size >= MAX_REQUESTS) requests.delete(requests.keys().next().value);
      const requestId = randomBytes(16).toString('hex');
      requests.set(requestId, Object.freeze({ notePath, text: typeof text === 'string' ? text : null, at: clock(),
        mappingId: isMappingNote(notePath) ? mapping.id : null }));
      return requestId;
    },

    // What the owner page shows: paths only, never note text.
    list() {
      expire();
      return [...requests].map(([requestId, request]) => ({ requestId, notePath: request.notePath,
        suggestedVaultPath: request.mappingId ? mapping.relativePath : request.notePath,
        fixedVaultPath: request.mappingId !== null, requestedAt: new Date(request.at).toISOString() }));
    },

    links() {
      return [...links].map(([notePath, link]) => ({ notePath, vaultPath: link.vaultPath, linkedAt: link.linkedAt }));
    },

    dismiss(requestId) { requests.delete(requestId); },

    // The owner's Confirm. Returns { linked: true, unchanged? } or
    // { linked: false, differences, many }. Throws a refusal code otherwise.
    confirm({ requestId, vaultPath }) {
      return serial(async () => {
        expire();
        const request = requests.get(requestId);
        if (!request) throw refusal('link-request-expired');
        if (!validNotePath(vaultPath)) throw refusal('link-path-refused');
        try { pathMatchesPolicy(vaultPath, config.paths); } catch { throw refusal('link-path-refused'); }
        // The configured publication page is the owner's own choice of file;
        // any other note links only to a file the site publishes.
        if (request.mappingId === null && !new Set(await noteStatus.publishedPaths()).has(vaultPath)) {
          throw refusal('link-path-not-published');
        }

        // The publication page: the node's own workspace copy against the vault,
        // recorded by the existing baseline binding.
        if (request.mappingId !== null) {
          if (vaultPath !== mapping.relativePath || publication === null || readMappingNote === null) throw refusal('link-path-refused');
          const committed = await noteStatus.committedText(vaultPath);
          let note;
          try { note = await readMappingNote(mapping); } catch { throw refusal('link-note-unavailable'); }
          const vaultText = committed === null ? '' : foldWorkspaceText(committed.bytes);
          const noteText = foldWorkspaceText(note.text);
          if (noteText !== vaultText) {
            requests.delete(requestId);
            return { linked: false, ...countDifferentLines(vaultText, noteText) };
          }
          await publication.bindWorkspaceBaseline({ mappingId: mapping.id });
          requests.delete(requestId);
          return { linked: true, notePath: request.notePath, vaultPath };
        }

        // Any other note: the text the device sent against the committed file.
        if (request.text === null) throw refusal('link-note-unavailable');
        const committed = await noteStatus.committedText(vaultPath);
        if (committed === null) throw refusal('link-path-not-published');
        let noteText;
        let vaultText;
        try {
          noteText = foldWorkspaceText(request.text);
          vaultText = foldWorkspaceText(committed.bytes);
        } catch { throw refusal('link-text-unreadable'); }
        if (noteText !== vaultText) {
          requests.delete(requestId);
          return { linked: false, ...countDifferentLines(vaultText, noteText) };
        }
        const foldedTextDigest = publicationDigest(Buffer.from(vaultText, 'utf8'));
        const previous = links.get(request.notePath);
        requests.delete(requestId);
        if (previous?.vaultPath === vaultPath && previous.foldedTextDigest === foldedTextDigest && previous.commit === committed.commit) {
          return { linked: true, unchanged: true, notePath: request.notePath, vaultPath };
        }
        const next = new Map(links);
        next.delete(request.notePath);
        next.set(request.notePath, Object.freeze({ vaultPath, commit: committed.commit, foldedTextDigest,
          linkedAt: new Date(clock()).toISOString() }));
        if (next.size > MAX_LINKS) throw refusal('link-capacity');
        await writeLinks(file, next);
        links = next;
        return { linked: true, notePath: request.notePath, vaultPath };
      });
    },
  });
}
