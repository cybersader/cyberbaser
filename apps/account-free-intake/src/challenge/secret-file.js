import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';

// Keep file values and filesystem diagnostics out of startup errors. The secret
// is private to the verifier closure and is never attached to config or queues.
export async function readSecretFile(secretFile) {
  let handle;
  try {
    if (await realpath(secretFile) !== secretFile) throw new Error();
    handle = await open(secretFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size < 1 || metadata.size > 4096) throw new Error();
    const secret = new TextDecoder('utf-8', { fatal: true }).decode(await handle.readFile()).trim();
    if (!/^\S{1,4096}$/u.test(secret)) throw new Error();
    return secret;
  } catch {
    throw new Error('botCheck.secretFile must be one readable bounded regular singly linked symlink-free secret file');
  } finally {
    await handle?.close();
  }
}

