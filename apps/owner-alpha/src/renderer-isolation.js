import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installed = fileURLToPath(new URL('../../../libexec/render-offline', import.meta.url));
const restrictedBin = fileURLToPath(new URL('../../../renderers/quartz-cyberbase/restricted-bin', import.meta.url));
const development = fileURLToPath(new URL('../../../packaging/dist/render-offline', import.meta.url));

// Trusted deployment switch, never derived from a note or persisted owner config.
async function requireExecutable(file) {
  if (!(await lstat(file)).isFile()) throw new Error('renderer launcher is not a regular file');
  await access(file, constants.X_OK);
  return file;
}

export async function rendererLauncher() {
  try {
    return await requireExecutable(installed);
  } catch (error) {
    if (error?.code !== 'ENOENT' || containerRendererIsolation() || installed.startsWith('/opt/cyberbaser/')) throw error;
  }
  try {
    return await requireExecutable(development);
  } catch (cause) {
    throw new Error('Build the source renderer launcher first: bun packaging/build.js --renderer-launcher-only', { cause });
  }
}
export function containerRendererIsolation() {
  return process.env.CYBERBASER_RENDERER_ISOLATION === 'socket-filter';
}

// A private scratch directory per invocation. Programs that ignore TMPDIR can
// still read /tmp, but the kernel will not let them write to the node's exec tmpfs.
export async function withIsolatedRenderer({ workspace, output, outputWriteRoot = output, env }, run) {
  if (outputWriteRoot !== output && outputWriteRoot !== path.dirname(output)) {
    throw new Error('renderer output write root must be the output or its dedicated staging parent');
  }
  await mkdir(output, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(path.join(workspace, '.render-tmp-'));
  try {
    return await run([workspace, outputWriteRoot, '--'], {
      ...env, PATH: `${restrictedBin}:${env.PATH ?? '/usr/bin:/bin'}`,
      ...(containerRendererIsolation() ? { HOME: scratch } : {}),
      TMPDIR: scratch, TMP: scratch, TEMP: scratch, XDG_CACHE_HOME: scratch,
      CYBERBASER_RENDER_BUN: process.execPath,
      CYBERBASER_RESTRICTED_RENDER: '1',
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
