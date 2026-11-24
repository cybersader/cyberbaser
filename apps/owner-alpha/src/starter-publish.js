// The starter publish.yml first-run setup can offer: exactly the folders the
// owner picked, nothing by default. One function writes it and one recognizes
// it, so the publisher can check a starter commit byte for byte without
// trusting the node's description of it.

export const STARTER_PATH = 'publish.yml';
export const STARTER_COMMIT_MESSAGE = 'cyberbaser: add publish.yml';
export const MAX_STARTER_FOLDERS = 200;
const MAX_STARTER_BYTES = 64 * 1024;

const HEAD = [
  '# What Cyberbaser may publish. Only notes in these folders go on your website.',
  '# Everything else stays private. Add or remove folders any time.',
];

/** A folder name setup can list: one top-level, visible, plain directory name. */
export function validStarterFolder(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 200 && !name.startsWith('.')
    && !name.includes('/') && !name.includes('\\') && name !== 'node_modules' && !/[\p{Cc}]/u.test(name);
}

/** The starter publish.yml text for exactly these folders, in the order given. */
export function starterPublishYml(folders) {
  if (folders.length === 0) return `${HEAD.join('\n')}\nallow: []\n`;
  return `${HEAD.join('\n')}\nallow:\n${folders.map((folder) => `  - ${JSON.stringify(`${folder}/**`)}`).join('\n')}\n`;
}

/**
 * The folders a starter file lists, or null when the bytes are anything other
 * than what starterPublishYml writes for sorted, distinct, valid folder names.
 */
export function parseStarterPublishYml(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_STARTER_BYTES) return null;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
  const lines = text.split('\n');
  if (lines.length < 4 || lines[0] !== HEAD[0] || lines[1] !== HEAD[1] || lines.at(-1) !== '') return null;
  let folders = [];
  if (lines[2] !== 'allow: []') {
    if (lines[2] !== 'allow:') return null;
    for (const line of lines.slice(3, -1)) {
      const match = /^ {2}- (".*")$/u.exec(line);
      if (!match) return null;
      let value;
      try { value = JSON.parse(match[1]); } catch { return null; }
      if (typeof value !== 'string' || !value.endsWith('/**')) return null;
      folders.push(value.slice(0, -3));
    }
    if (folders.length === 0) return null;
  }
  if (folders.length > MAX_STARTER_FOLDERS || !folders.every(validStarterFolder) || new Set(folders).size !== folders.length) return null;
  const sorted = [...folders].sort((a, b) => a.localeCompare(b));
  if (sorted.some((folder, index) => folder !== folders[index])) return null;
  folders = sorted;
  return starterPublishYml(folders) === text ? folders : null;
}
