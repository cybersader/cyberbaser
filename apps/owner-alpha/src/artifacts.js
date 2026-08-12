import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fail, OwnerAlphaError } from './errors.js';
import { artifactJson } from './json.js';
import {
  assertSafeStoreTarget,
  prepareStore,
  prepareStoreParent,
  resolveStorePath,
} from './store.js';

function temporaryName(file) {
  return `${file}.tmp-${process.pid}-${randomUUID()}`;
}

function bytesFor(value, maxBytes) {
  const contents = artifactJson(value);
  const bytes = Buffer.byteLength(contents, 'utf8');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    fail('invalid-artifact-limit', 'maxBytes must be a positive safe integer');
  }
  if (bytes > maxBytes) {
    fail('artifact-too-large', `artifact is ${bytes} bytes and exceeds the ${maxBytes}-byte limit`);
  }
  return contents;
}

async function writeTemporary(file, contents) {
  const temporary = temporaryName(file);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    return temporary;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally {
    await handle?.close();
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function assertExistingRegularFile(file) {
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('artifact-not-found', `${path.basename(file)} does not exist`);
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    fail('unsafe-artifact', `${path.basename(file)} must be one regular, unlinked file`);
  }
}

export async function createJsonArtifactOnce(
  context,
  relativePath,
  value,
  { maxBytes = 8 * 1024 * 1024 } = {},
) {
  await prepareStore(context);
  const file = resolveStorePath(context, relativePath);
  await prepareStoreParent(context, file);
  const contents = bytesFor(value, maxBytes);
  const temporary = await writeTemporary(file, contents);
  try {
    await link(temporary, file);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    if (error?.code === 'EEXIST') {
      fail('artifact-already-exists', `${path.basename(file)} already exists and is immutable`);
    }
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  return file;
}

export async function replaceJsonArtifactAtomic(
  context,
  relativePath,
  value,
  { maxBytes = 8 * 1024 * 1024 } = {},
) {
  await prepareStore(context);
  const file = resolveStorePath(context, relativePath);
  await prepareStoreParent(context, file);
  await assertExistingRegularFile(file);
  const contents = bytesFor(value, maxBytes);
  const temporary = await writeTemporary(file, contents);
  try {
    await rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await rm(temporary, { force: true });
  }
  return file;
}

export async function readJsonArtifact(
  context,
  relativePath,
  { maxBytes = 8 * 1024 * 1024 } = {},
) {
  await prepareStore(context);
  const file = resolveStorePath(context, relativePath);
  await assertSafeStoreTarget(context, file);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) {
      fail('unsafe-artifact', `${path.basename(file)} must be one regular, unlinked file`);
    }
    if (metadata.size > maxBytes) {
      fail('artifact-too-large', `${path.basename(file)} exceeds the ${maxBytes}-byte read limit`);
    }
    const value = JSON.parse(await handle.readFile('utf8'));
    return value;
  } catch (error) {
    if (error instanceof OwnerAlphaError) throw error;
    if (error?.code === 'ENOENT') fail('artifact-not-found', `${path.basename(file)} does not exist`);
    if (error?.code === 'ELOOP') fail('unsafe-artifact', `${path.basename(file)} must not be a symlink`);
    if (error instanceof SyntaxError) fail('invalid-artifact-json', `${path.basename(file)} is not strict JSON`);
    throw error;
  } finally {
    await handle?.close();
  }
}
