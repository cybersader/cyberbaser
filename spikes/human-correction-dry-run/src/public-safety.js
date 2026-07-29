const PRIVATE_PATH_RE = /(?:^|[\s"'(])(?:\/tmp\/|\/home\/|\/Users\/|[A-Za-z]:[\\/]|\\\\)/u;
const CREDENTIAL_RE = /(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]+)/u;

export function scanPublicValue(value, {
  label = 'public evidence',
  fail,
} = {}) {
  const reject = typeof fail === 'function'
    ? fail
    : (code, message) => { throw Object.assign(new Error(message), { code }); };

  if (typeof value === 'string') {
    if (PRIVATE_PATH_RE.test(value)) reject('private-path', `${label} contains a private local path`);
    if (CREDENTIAL_RE.test(value)) reject('credential', `${label} contains credential-like material`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanPublicValue(item, { label: `${label}[${index}]`, fail: reject }));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      scanPublicValue(item, { label: `${label}.${key}`, fail: reject });
    }
  }
}
