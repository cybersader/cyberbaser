// The installed program's on-disk files, embedded in the program at build time.
import tarball from '../dist/resources.tar' with { type: 'file' };

import launcher from '../dist/render-offline' with { type: 'file' };

export const RENDER_LAUNCHER = launcher;
export const RESOURCES_TAR = tarball;
