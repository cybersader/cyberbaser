import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installed = fileURLToPath(new URL('../../../libexec/render-offline', import.meta.url));
const development = fileURLToPath(new URL('../../../packaging/dist/render-offline', import.meta.url));

// Trusted deployment switch, never derived from a note or persisted owner config.
export async function rendererLauncher() {
  try {
    await lstat(installed);
    return installed;
  } catch (error) {
    if (error?.code !== 'ENOENT' || containerRendererIsolation()) throw error;
    return development;
  }
}
export function containerRendererIsolation() {
  return process.env.CYBERBASER_RENDERER_ISOLATION === 'socket-filter';
}

// A private scratch directory per invocation. Programs that ignore TMPDIR can
// still read /tmp, but the kernel will not let them write to the node's exec tmpfs.
export async function withIsolatedRenderer({ workspace, output, outputWriteRoot = output, cache, env }, run) {
  if (outputWriteRoot !== output && outputWriteRoot !== path.dirname(output)) {
    throw new Error('renderer output write root must be the output or its dedicated staging parent');
  }
  await mkdir(output, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(path.join(workspace, '.render-tmp-'));
  try {
    if (cache) await mkdir(cache, { mode: 0o700 }).catch((error) => {
      if (error?.code !== 'EEXIST') throw error;
    });
    return await run([workspace, outputWriteRoot, ...(cache ? ['--renderer-cache', cache] : []), '--'], {
      ...env, ...(containerRendererIsolation() ? { HOME: scratch } : {}),
      TMPDIR: scratch, TMP: scratch, TEMP: scratch, XDG_CACHE_HOME: scratch,
      CYBERBASER_RESTRICTED_RENDER: '1',
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
