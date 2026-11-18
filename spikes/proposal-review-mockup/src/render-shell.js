import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SHELL = fileURLToPath(new URL('../public/index.html', import.meta.url));
const TOKEN = '__CYBERBASER_FIXTURE_MODEL__';

export function escapeJsonForHtml(value) {
  return JSON.stringify(value)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');
}

export async function renderShell(viewModel) {
  const shell = await readFile(SHELL, 'utf8');
  if (!shell.includes(TOKEN)) throw new Error('tracked mockup shell is missing its fixture-model token');
  return shell.replace(TOKEN, escapeJsonForHtml(viewModel));
}
