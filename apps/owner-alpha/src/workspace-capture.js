import { fail } from './errors.js';
import { boundedText, plainData } from './core/device-keys.js';

export async function readWorkspaceCapture(file) {
  const maxBytes = 1024 * 1024;
  try {
    const input = Bun.file(file);
    if (input.size > maxBytes) throw new Error();
    const bytes = await input.slice(0, maxBytes + 1).arrayBuffer();
    if (bytes.byteLength > maxBytes) throw new Error();
    const value = plainData(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), ['source', 'path', 'text']);
    if (!value || !boundedText(value.source, 256) || !boundedText(value.path, 4096)
      || typeof value.text !== 'string') throw new Error();
    return value;
  } catch {
    fail('invalid-capture', 'Capture must be a bounded JSON object with source, path and text.');
  }
}
