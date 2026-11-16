import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_MAX_PAGES = 400;
export const MAX_COPY_BYTES = 50 * 1024 * 1024;
const within = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
const safePath = (value) => typeof value === 'string' && value.length > 0 && !/[\\\x00-\x1f\x7f]/u.test(value)
  && !value.split('/').some((part) => !part || part === '.' || part === '..' || ['.git', '.workspace', '.cyberbaser', '.obsidian', '.trash', 'node_modules'].includes(part));

export function validateCopyOptions({ from = null, folder = null, ref = 'origin/main', maxPages = DEFAULT_MAX_PAGES } = {}) {
  if (from === null) {
    if (folder !== null || ref !== 'origin/main' || maxPages !== DEFAULT_MAX_PAGES) throw new Error('--folder, --ref and --max-pages require --from.');
    return;
  }
  if (typeof from !== 'string' || !from.trim()) throw new Error('--from needs a source Git vault path.');
  if (!safePath(folder) || /[*?]/u.test(folder)) throw new Error('--from requires --folder with a literal vault-relative folder (no dot, parent or wildcard segments).');
  if (typeof ref !== 'string' || !ref.trim() || /[\x00-\x1f\x7f]/u.test(ref)) throw new Error('--ref needs a commit-ish such as origin/main.');
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error('--max-pages needs a positive whole number.');
}

/** Read committed objects only. No source checkout, index, refs or config is written. */
export async function copyCommittedFolder({ from, folder, ref = 'origin/main', maxPages = DEFAULT_MAX_PAGES, checkout, root, projectRoot, command }) {
  validateCopyOptions({ from, folder, ref, maxPages });
  let source;
  try { source = await realpath(path.resolve(from)); }
  catch { throw new Error('The --from source vault does not exist or is not readable.'); }
  if (within(path.join(projectRoot, 'docs'), source) || within(root, source)
    || (within(path.join(projectRoot, '.workspace'), source) && path.relative(path.join(projectRoot, '.workspace'), source).split(path.sep)[0].startsWith('try-suggestions-'))) {
    throw new Error('--from must not be the project docs or a rehearsal throwaway directory.');
  }
  const git = async (args, maxBuffer = 16 * 1024 * 1024) => {
    const { stdout } = await command('git', ['--no-replace-objects', '-C', source, '-c', 'protocol.allow=never',
      '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'buffer', maxBuffer, timeout: 15_000 });
    return Buffer.from(stdout);
  };
  let commit;
  try {
    const top = (await git(['rev-parse', '--show-toplevel'])).toString('utf8').trim();
    if (await realpath(top) !== source) throw new Error('not root');
  } catch { throw new Error('--from must name the root of a readable Git vault.'); }
  try { commit = (await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).toString('utf8').trim(); }
  catch { throw new Error(`Source ref “${ref}” does not exist as a local commit. No fetch is performed.`); }
  let entries;
  try {
    const bytes = await git(['ls-tree', '-r', '-z', '-l', commit, '--', folder, '_attachments']);
    if (!Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error('non-UTF-8 path');
    entries = bytes.toString('utf8').split('\0').filter(Boolean).map((line) => {
      const match = line.match(/^(\d+) (\w+) ([a-f0-9]+) +(-|\d+)\t([\s\S]+)$/u);
      if (!match) throw new Error('tree entry');
      return { mode: match[1], type: match[2], oid: match[3], size: Number(match[4]), name: match[5] };
    });
  } catch { throw new Error('The committed source tree could not be read within the rehearsal limits.'); }
  const pages = entries.filter((entry) => entry.name.startsWith(`${folder}/`) && /\.md$/iu.test(entry.name));
  if (!entries.some((entry) => entry.name.startsWith(`${folder}/`))) throw new Error(`Source folder “${folder}” does not exist or is empty at “${ref}”.`);
  if (!pages.length) throw new Error(`Source folder “${folder}” has no Markdown pages at “${ref}”.`);
  if (pages.length > maxPages) throw new Error(`Source folder has ${pages.length} Markdown pages; the limit is ${maxPages}. Raise --max-pages explicitly to copy more.`);
  const regular = (entry) => {
    if (!safePath(entry.name) || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || !Number.isSafeInteger(entry.size)) {
      throw new Error('The copy contains an unsafe path, symlink or non-regular source file.');
    }
  };
  let pageBytes = 0;
  const contents = new Map();
  const fileMap = {};
  for (const entry of pages) {
    regular(entry);
    pageBytes += entry.size;
    if (pageBytes > MAX_COPY_BYTES) throw new Error('Markdown copy exceeds the 50 MiB total limit. Choose a smaller folder.');
    const bytes = await git(['cat-file', 'blob', entry.oid], MAX_COPY_BYTES + 1024);
    contents.set(entry.name, bytes);
    fileMap[entry.name] = bytes.toString('utf8');
  }
  // Load the dependency only in copy mode, preserving the synthetic launcher's
  // preparation guidance when app dependencies have not been installed yet.
  const { extractRefs, selectFiles, sluggify } = await import('../../../packages/publish/src/index.js');
  // This is the owner's real deny-wins selector, not a rehearsal frontmatter parser.
  const selection = selectFiles(fileMap, { allow: [folder] });
  if (selection.errors.length) throw new Error('Publication selection refused the copied folder. Fix its publication/frontmatter errors or choose another folder.');
  const publishedPages = selection.report.published.pages;
  if (!publishedPages.length) throw new Error('The copied folder has no published pages; publish: false and cb-publish: false still deny.');
  const attachments = entries.filter((entry) => entry.name.startsWith('_attachments/') && !/\.md$/iu.test(entry.name));
  const byPath = new Map(attachments.map((entry) => [entry.name, entry]));
  const referenced = new Map();
  for (const page of publishedPages) {
    const refs = extractRefs(fileMap[page]);
    for (const link of [...refs.embeds, ...refs.wikilinks, ...refs.mdImages, ...refs.mdLinks]) {
      if (!link.target || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(link.target)) continue;
      let target = link.target.split('#')[0].split('?')[0];
      try { target = decodeURIComponent(target); } catch { /* Keep literal target. */ }
      const exact = byPath.get(target.replace(/^\//u, '')) ?? byPath.get(path.posix.normalize(path.posix.join(path.posix.dirname(page), target)));
      const matches = exact ? [exact] : attachments.filter((entry) => path.posix.basename(entry.name) === path.posix.basename(target));
      if (matches.length > 1) throw new Error(`Attachment filename “${path.posix.basename(target)}” is ambiguous. Use an exact _attachments path in a different source snapshot.`);
      if (matches.length === 1) referenced.set(matches[0].name, matches[0]);
    }
  }
  let attachmentBytes = 0;
  for (const entry of referenced.values()) {
    regular(entry);
    attachmentBytes += entry.size;
    if (attachmentBytes > MAX_COPY_BYTES) throw new Error('Referenced attachments exceed the 50 MiB total limit. Choose a smaller folder.');
  }
  // Read all selected bytes before writing anything; destination is the fresh owned checkout.
  for (const entry of referenced.values()) contents.set(entry.name, await git(['cat-file', 'blob', entry.oid], MAX_COPY_BYTES + 1024));
  for (const [name, bytes] of contents) {
    const destination = path.join(checkout, ...name.split('/'));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { mode: 0o600, flag: 'wx' });
  }
  const pageLink = (name) => sluggify(name, false).split('/').map(encodeURIComponent).join('/');
  const sourceLink = (name) => name.split('/').map(encodeURIComponent).join('/');
  const index = '# Rehearsal copy\n\nThese pages are disposable copies. Suggestions edit only this throwaway vault, never the source.\n\n'
    + publishedPages.map((name) => `- [${name.replace(/[\[\]\\]/gu, '\\$&')}](${sourceLink(name)})`).join('\n') + '\n';
  await writeFile(path.join(checkout, 'index.md'), index, { mode: 0o600, flag: 'wx' });
  return { ref, commit, folder, pages: pages.length, publishedPages, attachments: referenced.size, attachmentBytes, pageLinks: publishedPages.slice(0, 5).map(pageLink) };
}
