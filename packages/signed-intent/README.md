# @cyberbaser/signed-intent

What the owner's device signs before anything is published, and how the isolated publisher checks it on its own. Design: [Signed publish](../../docs/src/content/docs/design/signed-publish.mdx).

Pure: no I/O, no clock reads, no dependencies. `src/intent.js` also avoids `node:crypto`, so a browser or the Obsidian plugin can import it and hash with WebCrypto. `test/vectors.json` holds the conformance vectors every implementation must reproduce.

## Format v1 (frozen)

Any change to the rules below is a new version with a new domain line.

### Bytes and digest

```
bytes  = UTF-8( "cyberbaser.publish-intent.v1" + "\n" + canonicalJson(intent) )
digest = SHA-256(bytes)                      (32 bytes; providers sign this)
```

`canonicalJson`: object keys sorted by JavaScript string order, no whitespace, `JSON.stringify` string escaping, safe integers only (no floats, no `-0`), no lone surrogates. Unknown or missing members are refused, never ignored.

### Envelope (every kind)

| Member | Rule |
|---|---|
| `v` | `1` |
| `kind` | `publish`, `enroll`, `key-add`, `key-revoke`, `recovery-reset` |
| `publisher` | the publisher's Ed25519 public key, 64 lowercase hex. Returned by the publisher's `challenge` |
| `keyId` | the signing key, `[A-Za-z0-9._-]{1,128}`. `recovery` is reserved for `recovery-reset` and only it |
| `nonce` | from the publisher's `challenge`, base64url of 32 bytes (43 chars). One use |
| `issuedAt`, `expiresAt` | Unix milliseconds; `0 < expiresAt - issuedAt <= 900000`. Use the challenge's `expiresAt` or earlier |

### `publish`

```json
{ "v": 1, "kind": "publish", "publisher": "…", "keyId": "phone-1", "nonce": "…", "issuedAt": 0, "expiresAt": 0,
  "target": { "remote": "https://github.com/owner/vault.git", "branch": "main" },
  "base": "<40-hex commit the branch must still point at; the commit's only parent>",
  "commit": {
    "author":    { "name": "Owner", "email": "owner@example.invalid", "time": 1800000000, "tz": "+0000" },
    "committer": { "name": "Owner", "email": "owner@example.invalid", "time": 1800000000, "tz": "+0000" },
    "message": "Edit notes/a.md\n" },
  "changes": [ { "path": "notes/a.md",
                 "before": { "mode": "100644", "sha256": "<64 hex of the exact old bytes>" },
                 "after":  { "mode": "100644", "sha256": "<64 hex of the exact new bytes>" } } ] }
```

- `commit.message`: the exact commit message bytes, ending in `\n`, at most 4096 UTF-8 bytes.
- People: `name` and `email` non-empty, no `<`, `>` or control characters, no outer spaces; `time` Unix seconds; `tz` `±HHMM`.
- `changes`: 1 to 64 entries, sorted by `path` (JavaScript string order), no duplicates, no path that is a parent of another. `before: null` adds a file, `after: null` deletes one. Modes `100644` or `100755` only (no symlinks, submodules or trees). Paths are repository-relative, `/`-separated, no empty, `.`, `..` or `.git` segment, no backslash or control character, at most 1024 bytes.
- **The device hashes the bytes it shows the owner**; it never trusts a hash or diff from the node.

The publisher refuses unless the commit it imported from the node has headers exactly `tree`, `parent <base>`, `author <signed>`, `committer <signed>` (no `gpgsig`, `encoding`, `mergetag`), the message bytes are equal, and `git diff-tree -r` from `base` lists exactly the signed paths with the signed modes and SHA-256 of each blob.

### Owner key (inside `enroll`, `key-add`, `recovery-reset`)

```json
{ "keyId": "phone-1", "type": "ed25519", "publicKey": "<base64url, 32 bytes>", "label": "Phone" }
{ "keyId": "mac-passkey", "type": "webauthn", "publicKeySpki": "<base64url DER>", "rpId": "localhost",
  "origins": ["http://localhost:4319"], "label": "This computer" }
```

`label`: 1 to 64 bytes, no `<`, `>` or control characters. Small-order and non-canonical Ed25519 keys are refused.

### Other kinds (`subject` member)

| Kind | `subject` | Signed by |
|---|---|---|
| `enroll` | `{ "key": <owner key>, "proof": <base64url 32> }` | the new key itself (`keyId` = `key.keyId`) |
| `key-add` | `{ "key": <owner key> }` | an existing owner key |
| `key-revoke` | `{ "keyId": "<key to remove>" }` | an existing owner key; the last key cannot be removed |
| `recovery-reset` | `{ "key": <owner key>, "recoveryKey": <base64url 32> or null }` | the recovery key (`keyId: "recovery"`); replaces every owner key |

### Signatures

- **Ed25519 device key**: `{ "type": "ed25519", "signature": base64url(Ed25519(privateKey, UTF-8("cyberbaser.publish-approval.ed25519.v1\n") ‖ digest)) }`. Pure RFC 8032; `s` must be below the group order.
- **WebAuthn**: `navigator.credentials.get` with `challenge = digest`; send `{ "type": "webauthn", "clientDataJSON", "authenticatorData", "signature" }` (base64url). Checked: `type` is `webauthn.get`, challenge equals the digest, origin enrolled, not cross-origin, RP ID hash, user present and verified, ES256 (P-256) or EdDSA, a non-zero counter must increase.

### Enrollment of the first device

The publisher shows a one-time code (installer terminal, its own log, or its loopback-only QR page): `obsidian://cyberbaser-enrol?publisher=<64 hex>&code=<32-character code>` (the Obsidian plugin's link; any other client takes the same two values). Codes are Crockford base32 of 20 bytes in groups of four (`I`/`L` read as `1`, `O` as `0`). The device then:

1. creates its key and asks the node for a `challenge` (it relays to the publisher);
2. sets `proof = base64url(HMAC-SHA256(secret, "cyberbaser.enroll-proof.v1\n" + publisher + "\n" + canonicalJson(key)))`;
3. signs an `enroll` intent with the new key and sends `{ intent, approval }`;
4. checks the answer's `confirm = base64url(HMAC-SHA256(secret, "cyberbaser.enroll-confirm.v1\n" + publisher + "\n" + digestHex))`. Only the real publisher holds the secret, so a node that substituted its own code or publisher key cannot produce it; pin `publisher` only after this check.

Both screens then show the same fingerprint: the first 16 hex of SHA-256 of `canonicalJson(key)`, in four groups.

### Recovery code

24 characters (15 bytes) in the same alphabet, printed once by the installer. The publisher stores only the derived public key. `seed = HKDF-SHA256(ikm = code bytes, salt = publisher key bytes, info = "cyberbaser.recovery-key.v1", 32)`, Ed25519 from that seed, `keyId: "recovery"`. Type it only into a client the node does not serve.

### Publisher statements

Receipts and the signed key list: `Ed25519(publisher key, UTF-8("cyberbaser.publisher-statement.v1\n" + canonicalJson(body)))`, base64url. A device shows "Published" only on a receipt that verifies under the publisher key it pinned.

## API

`validateIntent`, `intentBytes`, `intentDigest`, `ed25519Provider`, `webauthnProvider`, `PROVIDERS`, `createNonceBook`, `admitApproval`, `checkCommit(git, intent, commit)`, `enrollProof`, `enrollConfirm`, `recoveryKeyFromCode`, `formatCode`, `parseCode`, `signStatement`, `verifyStatement`, `keyFingerprint`.

`bun test test` runs the vectors and unit tests; `bun test/make-vectors.js` regenerates the vectors (only when the format version changes).
