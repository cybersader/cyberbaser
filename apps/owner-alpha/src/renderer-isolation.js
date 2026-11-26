// Trusted deployment switch, never derived from a note, renderer or persisted
// owner config. The TrueNAS entrypoint sets it; absence preserves native behavior.
export const CONTAINER_RENDERER_LAUNCHER = '/opt/cyberbaser/libexec/render-offline';
export function containerRendererIsolation() {
  return process.env.CYBERBASER_RENDERER_ISOLATION === 'socket-filter';
}
