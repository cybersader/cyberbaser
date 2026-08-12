import {
  deepFreeze,
  fail,
  FORGEJO_ID_RE,
  FORGEJO_INTAKE_SCHEMA_VERSION,
  requireExactKeys,
  requireString,
} from './contract.js';

const CONFIG_KEYS = ['schemaVersion', 'forgejo', 'repository'];
const FORGEJO_KEYS = ['apiBaseUrl'];
const REPOSITORY_KEYS = ['url', 'owner', 'name', 'baseBranch'];

function rejectUrlAliases(value, parsed, label) {
  if (parsed.hostname.endsWith('.')) {
    fail('noncanonical-url', `${label} must not use a trailing-dot hostname alias`);
  }
  if (/%(?![0-9A-Fa-f]{2})/u.test(value)) {
    fail('noncanonical-url', `${label} contains an invalid percent escape`);
  }
  for (const match of value.matchAll(/%([0-9A-Fa-f]{2})/gu)) {
    const hex = match[1];
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    if (
      hex !== hex.toUpperCase()
      || /[A-Za-z0-9._~-]/u.test(character)
      || character === '/'
      || character === '\\'
    ) {
      fail('noncanonical-url', `${label} must use one canonical URL spelling`);
    }
  }
}

function canonicalHttpsUrl(value, label) {
  requireString(value, label, { maxBytes: 2048 });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('invalid-url', `${label} must be an absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || value.includes('?')
    || value.includes('#')
  ) {
    fail('invalid-url', `${label} must be a credential-free HTTPS URL without query or fragment`);
  }
  rejectUrlAliases(value, parsed, label);
  if (parsed.toString() !== value) {
    fail('noncanonical-url', `${label} must use its canonical URL spelling`);
  }
  return parsed;
}

function requireForgejoId(value, label) {
  if (typeof value !== 'string' || !FORGEJO_ID_RE.test(value) || value.endsWith('.')) {
    fail('invalid-forgejo-identifier', `${label} must be a bounded Forgejo identifier`);
  }
  return value;
}

function requireBranch(value) {
  requireString(value, 'repository.baseBranch', { maxBytes: 255 });
  if (
    value.startsWith('-')
    || value.startsWith('/')
    || value.endsWith('/')
    || value.endsWith('.')
    || value.includes('..')
    || value.includes('@{')
    || value.includes('//')
    || /[\x00-\x20\x7f~^:?*\[\\]/u.test(value)
    || value.split('/').some((segment) => segment === '' || segment.endsWith('.lock'))
  ) {
    fail('invalid-git-branch', 'repository.baseBranch must be a safe Git branch name');
  }
  return value;
}

export function validateForgejoIntakeConfig(value) {
  requireExactKeys(value, CONFIG_KEYS, 'config');
  if (value.schemaVersion !== FORGEJO_INTAKE_SCHEMA_VERSION) {
    fail('unsupported-schema', `config.schemaVersion must be ${FORGEJO_INTAKE_SCHEMA_VERSION}`);
  }
  requireExactKeys(value.forgejo, FORGEJO_KEYS, 'config.forgejo');
  requireExactKeys(value.repository, REPOSITORY_KEYS, 'config.repository');

  const owner = requireForgejoId(value.repository.owner, 'repository.owner');
  const name = requireForgejoId(value.repository.name, 'repository.name');
  const api = canonicalHttpsUrl(value.forgejo.apiBaseUrl, 'forgejo.apiBaseUrl');
  const repository = canonicalHttpsUrl(value.repository.url, 'repository.url');
  if (api.origin !== repository.origin || api.pathname !== '/api/v1') {
    fail(
      'forgejo-origin-mismatch',
      'forgejo.apiBaseUrl must be exact same-origin /api/v1 for repository.url',
    );
  }
  if (repository.pathname !== `/${owner}/${name}.git`) {
    fail(
      'repository-url-mismatch',
      'repository.url must exactly match repository.owner and repository.name',
    );
  }

  return deepFreeze({
    schemaVersion: FORGEJO_INTAKE_SCHEMA_VERSION,
    forgejo: {
      apiBaseUrl: api.toString(),
      origin: api.origin,
    },
    repository: {
      url: repository.toString(),
      owner,
      name,
      fullName: `${owner}/${name}`,
      baseBranch: requireBranch(value.repository.baseBranch),
    },
  });
}
