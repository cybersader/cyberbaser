// The installed program's on-disk files, embedded in the program at build time.
import tarball from '../dist/resources.tar' with { type: 'file' };

export const RESOURCES_TAR = tarball;
