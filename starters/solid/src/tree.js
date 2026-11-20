import {
  closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync,
  readSync,
} from 'node:fs';
import path from 'node:path';

const UNSAFE_SEGMENT = /[\\\u0000-\u001f\u007f�]/u;

export function isSafeSegment(segment) {
  return segment !== '' && segment !== '.' && segment !== '..' && !UNSAFE_SEGMENT.test(segment);
}

function argumentPath(raw) {
  if (!raw || UNSAFE_SEGMENT.test(raw) || raw.split('/').includes('..')) {
    throw new Error('expected a path without parent traversal, backslashes or control characters');
  }
  return path.resolve(raw);
}

function assertDirectoryChain(dir) {
  const { root } = path.parse(dir);
  let current = root;
  for (const segment of dir.slice(root.length).split('/').filter(Boolean)) {
    current = path.join(current, segment);
    if (!lstatSync(current).isDirectory()) {
      throw new Error(`not a directory or is a symlink: ${JSON.stringify(current)}`);
    }
  }
}

export function buildPaths(inputArg, outputArg) {
  const input = argumentPath(inputArg);
  const output = argumentPath(outputArg);
  if (input === output || input === '/' || output.startsWith(`${input}/`)) {
    throw new Error('output must be outside the projected tree');
  }
  assertDirectoryChain(input);
  assertDirectoryChain(path.dirname(output));
  if (lstatSync(output, { throwIfNoEntry: false })) throw new Error('output already exists');
  return { input, output };
}

export function scanTree(root) {
  const files = [];
  const pending = [''];
  while (pending.length) {
    const directory = pending.pop();
    for (const name of readdirSync(path.join(root, directory))) {
      const relative = directory ? `${directory}/${name}` : name;
      if (!isSafeSegment(name)) throw new Error(`unsafe path: ${JSON.stringify(relative)}`);
      const absolute = path.join(root, relative);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) pending.push(relative);
      else if (stat.isFile() && stat.nlink === 1) files.push({ absolute, relative, stat });
      else throw new Error(`symlink or non-regular entry: ${JSON.stringify(relative)}`);
    }
  }
  return files.sort((a, b) => a.relative < b.relative ? -1 : a.relative === b.relative ? 0 : 1);
}

function withFile(file, read) {
  const fd = openSync(file.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== file.stat.dev || stat.ino !== file.stat.ino) {
      throw new Error(`input changed during build: ${JSON.stringify(file.relative)}`);
    }
    return read(fd);
  } finally {
    closeSync(fd);
  }
}

export const readInput = (file) => withFile(file, readFileSync);

const isRaster = {
  '.png': (header) => header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  '.jpg': (header) => header.subarray(0, 3).equals(Buffer.from([255, 216, 255])),
  '.gif': (header) => ['GIF87a', 'GIF89a'].includes(header.toString('ascii', 0, 6)),
  '.webp': (header) => header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP',
};
isRaster['.jpeg'] = isRaster['.jpg'];

export function rasterValidator(file) {
  const match = isRaster[path.extname(file.relative).toLowerCase()];
  if (!match) return undefined;
  return withFile(file, (fd) => {
    const header = Buffer.alloc(12);
    const length = readSync(fd, header, 0, header.length, 0);
    return match(header.subarray(0, length)) ? match : undefined;
  });
}
