import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';

// Trusted deployment switch, never derived from a note, renderer or persisted
// owner config. The TrueNAS entrypoint sets it; absence preserves native behavior.
export const CONTAINER_RENDERER_LAUNCHER = '/opt/cyberbaser/libexec/render-offline';
export function containerRendererIsolation() {
  return process.env.CYBERBASER_RENDERER_ISOLATION === 'socket-filter';
}

// A private scratch directory per invocation. Programs that ignore TMPDIR can
// still read /tmp, but the kernel will not let them write to the node's exec tmpfs.
export async function withContainerRenderer({ workspace, output, env }, run) {
  await mkdir(output, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(path.join(workspace, '.render-tmp-'));
  try {
    return await run([workspace, output, '--'], {
      ...env, HOME: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch, XDG_CACHE_HOME: scratch,
      CYBERBASER_RESTRICTED_RENDER: '1',
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
