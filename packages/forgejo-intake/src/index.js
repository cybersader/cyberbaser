export {
  FORGEJO_INTAKE_SCHEMA_VERSION,
  FORGEJO_INTAKE_SUPPORTED_MAJOR,
  FORGEJO_INTAKE_MAX_API_BYTES,
  FORGEJO_INTAKE_MAX_BLOB_BYTES,
  FORGEJO_INTAKE_MAX_GIT_OUTPUT_BYTES,
  FORGEJO_INTAKE_TIMEOUT_MS,
  ForgejoIntakeError,
} from './contract.js';

export { validateForgejoIntakeConfig } from './config.js';
export { createForgejoApi } from './api.js';
export { createForgejoGitReader } from './git.js';
export {
  deriveForgejoPullRequestProposal,
  readForgejoPullRequestProposal,
} from './adapter.js';
