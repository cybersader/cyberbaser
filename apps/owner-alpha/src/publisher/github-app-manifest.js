// Registering Cyberbaser's GitHub App from a manifest, and signing in to it
// through the web flow. Publisher only: the node asks for each step over the
// forge control socket and gets back URLs, the manifest and the public client
// ID, never a secret.
//
//   https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
//   https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
//
// The owner's whole path is GitHub's own buttons:
//   1. Create: the setup page posts the manifest to GitHub's new-app page;
//      GitHub returns to the setup page with a one-hour code and our state.
//   2. The publisher converts the code. Of the answer it keeps the app id, slug,
//      client ID and client secret (needed to exchange a web sign-in code). The
//      private key and webhook secret are dropped at once: never written,
//      never logged, the received bytes zeroed.
//   3. Install: GitHub's install page, then back to the setup URL.
//   4. Authorize: GitHub's authorize page with our state and a PKCE challenge,
//      then back to the callback; the publisher exchanges the code with the
//      client secret and the PKCE verifier for an expiring user token.
//
// Install-time OAuth (request_oauth_on_install) is deliberately off: GitHub
// documents no state for it, so its callback could not be tied to this setup.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import { OwnerAlphaError } from '../errors.js';

export const REGISTRATION_FILE = 'github-app-registration.json';
export const MANIFEST_STATE_TTL_MS = 20 * 60_000; // GitHub's code lives an hour; the click is minutes.
export const INSTALL_WINDOW_TTL_MS = 30 * 60_000;
export const AUTHORIZE_STATE_TTL_MS = 10 * 60_000;
export const CALLBACK_PATHS = Object.freeze({
  created: '/setup/github/app-created',
  installed: '/setup/github/installed',
  authorized: '/setup/github/authorized',
});
export const HOMEPAGE = 'https://github.com/cybersader/cyberbaser';
const MAX_CONVERSION_BYTES = 64 * 1024;
const CLIENT_ID = /^Iv[0-9A-Za-z.]{6,40}$/u;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const SECRET = /^[0-9A-Za-z_.-]{20,128}$/u;
const CODE = /^[A-Za-z0-9_-]{8,128}$/u;
const STATE = /^[A-Za-z0-9_-]{43}$/u;
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:([0-9]{2,5})$/u;

function problem(code, message) {
  return new OwnerAlphaError(code, message);
}

export function validCallbackOrigin(value) {
  const match = typeof value === 'string' ? LOOPBACK_ORIGIN.exec(value) : null;
  return match !== null && Number(match[1]) > 0 && Number(match[1]) < 65536;
}
export function validCode(value) { return typeof value === 'string' && CODE.test(value); }
export function validState(value) { return typeof value === 'string' && STATE.test(value); }

function token() { return randomBytes(32).toString('base64url'); }

function sameText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A default app name: GitHub app names are global and at most 34 characters; the owner may edit it on GitHub's page. */
export function defaultAppName(hint = os.hostname(), suffix = randomBytes(2).toString('hex')) {
  const clean = String(hint ?? '').replace(/[^A-Za-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 16);
  return `Cyberbaser ${clean ? `${clean} ` : ''}${suffix}`.slice(0, 34);
}

/**
 * The manifest. Contents write and metadata read only (the publisher refuses
 * anything more), no webhook, no events, private to the owner's account.
 */
export function buildManifest({ origin, name = defaultAppName() }) {
  if (!validCallbackOrigin(origin)) throw problem('app-state-invalid', 'setup callbacks must be on 127.0.0.1');
  return {
    name,
    url: HOMEPAGE,
    description: 'Publishes approved changes to the one repository that holds your notes.',
    hook_attributes: { url: HOMEPAGE, active: false },
    redirect_url: `${origin}${CALLBACK_PATHS.created}`,
    callback_urls: [`${origin}${CALLBACK_PATHS.authorized}`],
    setup_url: `${origin}${CALLBACK_PATHS.installed}`,
    setup_on_update: false,
    request_oauth_on_install: false,
    public: false,
    default_permissions: { contents: 'write', metadata: 'read' },
    default_events: [],
  };
}

/**
 * The conversion answer, reduced to what the publisher keeps. `bytes` is the
 * raw body; it is zeroed before this returns, and the private key and webhook
 * secret are dropped from the parsed object. (A JavaScript string cannot be
 * zeroed; the decoded text is unreferenced on return and never stored.)
 */
export function reduceConversion(bytes) {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_CONVERSION_BYTES) {
      throw problem('app-conversion-failed', 'GitHub answered the app creation unexpectedly');
    }
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { body = null; }
    if (body && typeof body === 'object') { body.pem = null; body.webhook_secret = null; delete body.pem; delete body.webhook_secret; }
    const owner = body?.owner;
    if (!body || !Number.isSafeInteger(body.id) || body.id <= 0 || typeof body.slug !== 'string' || !SLUG.test(body.slug)
      || typeof body.client_id !== 'string' || !CLIENT_ID.test(body.client_id)
      || typeof body.client_secret !== 'string' || !SECRET.test(body.client_secret)
      || typeof owner?.login !== 'string' || !LOGIN.test(owner.login) || !Number.isSafeInteger(owner.id)) {
      throw problem('app-conversion-failed', 'GitHub answered the app creation unexpectedly');
    }
    const permissions = body.permissions ?? {};
    const extra = Object.keys(permissions).filter((name) => !['contents', 'metadata'].includes(name));
    if (extra.length > 0 || (permissions.contents !== undefined && permissions.contents !== 'write')) {
      throw problem('permissions-too-broad', 'the created app asks for more than contents');
    }
    return {
      createdBy: 'manifest', id: body.id, slug: body.slug, name: typeof body.name === 'string' ? body.name.slice(0, 64) : body.slug,
      clientId: body.client_id, clientSecret: body.client_secret, owner: { login: owner.login, id: owner.id },
    };
  } finally {
    if (bytes instanceof Uint8Array) bytes.fill(0);
  }
}

/** The public part of a registration: what the node and the page may see. */
export function publicApp(registration) {
  return registration === null ? null : { clientId: registration.clientId, slug: registration.slug ?? null,
    createdBy: registration.createdBy ?? null, signIn: registration.clientSecret ? 'web' : 'device' };
}

function pkce() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * One-use, short-lived states for the three GitHub round trips. Each kind holds
 * at most one outstanding entry; starting again replaces it.
 */
export function createFlowStates({ now = Date.now } = {}) {
  const outstanding = new Map(); // kind -> { state, origin, expiresAt, extra }
  return Object.freeze({
    open(kind, origin, ttlMs, extra = {}) {
      const entry = { state: token(), origin, expiresAt: now() + ttlMs, ...extra };
      outstanding.set(kind, entry);
      return entry;
    },
    // Consumes the entry whatever the outcome, so a state is tried once.
    take(kind, state) {
      const entry = outstanding.get(kind);
      if (!entry || !validState(state)) return null;
      if (!sameText(entry.state, state)) return null;
      outstanding.delete(kind);
      return entry.expiresAt > now() ? entry : null;
    },
    // The install window has no state GitHub promises to return: it is open or not.
    takeWindow(kind) {
      const entry = outstanding.get(kind);
      outstanding.delete(kind);
      return entry && entry.expiresAt > now() ? entry : null;
    },
    pending(kind) {
      const entry = outstanding.get(kind);
      return Boolean(entry && entry.expiresAt > now());
    },
    clear() { outstanding.clear(); },
  });
}

export function authorizeRequest({ webOrigin, clientId, origin, flows }) {
  const { verifier, challenge } = pkce();
  const redirectUri = `${origin}${CALLBACK_PATHS.authorized}`;
  const entry = flows.open('authorize', origin, AUTHORIZE_STATE_TTL_MS, { verifier, redirectUri });
  const url = new URL('/login/oauth/authorize', webOrigin);
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state: entry.state,
    code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  return { url: url.toString() };
}
