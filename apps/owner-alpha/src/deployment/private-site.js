// Private-only publication (workflow.provider "private-site"). There is no
// public website and no deployment service to watch. After the publisher
// pushes, the "deployment" is the node rebuilding its own private site from
// that exact commit, and "Live" means the node's private reader serves the
// changed page. Evidence keeps the shape of the public path (a bound run, a
// successful result for the exact commit, then a page check) and says
// `private-site` / `private-site-live` wherever it is recorded, so it can never
// be mistaken for a public deployment. Nothing here talks to GitHub.
import { fail } from '../errors.js';
import { validatePrivateNetworkHttpOrigin } from '../network.js';
import { readSiteBase } from '../site-base.js';

export const PRIVATE_SITE_PROVIDER = 'private-site';
export const PRIVATE_SITE_LIVE = 'private-site-live';
const SHA = /^[0-9a-f]{40}$/u;

function exactSha(value) {
  if (typeof value !== 'string' || !SHA.test(value)) fail('invalid-application-sha', 'applicationSha must be one full commit ID');
  return value;
}

/** The private reader's origin and base: http://HOST:READERPORT/<site base>. */
export async function privateReaderBase(config) {
  const origin = `http://${config.listen.host}:${config.listen.readerPort}`;
  validatePrivateNetworkHttpOrigin(origin, 'private reader origin');
  return `${origin}${await readSiteBase(config)}`;
}

/**
 * The private reader address of a page or image whose identity address is
 * under live.baseUrl. Anything outside that base is refused.
 */
export function privateUrlFor(config, readerBase, url) {
  const base = config.live.baseUrl;
  if (typeof url !== 'string' || !url.startsWith(base)) {
    fail('live-url-outside-configured-base', 'the page is not under the configured site address');
  }
  return new URL(url.slice(base.length), readerBase).toString();
}

/** The run is the node's own build, bound to the exact pushed commit. */
export async function discoverPrivateSiteRun({ config, applicationSha } = {}) {
  if (config?.workflow?.provider !== PRIVATE_SITE_PROVIDER) fail('unsupported-deployment-provider', 'not a private-site config');
  return Object.freeze({ binding: Object.freeze({ provider: PRIVATE_SITE_PROVIDER, runId: '1', headSha: exactSha(applicationSha) }) });
}

/**
 * Rebuild the private site from the checkout, which must already be at the
 * pushed commit, and record that build as the deployment of that commit.
 * `rebuild` is injectable for tests; by default the owner site build.
 */
export async function monitorPrivateSiteDeployment({ config, applicationSha, boundRun, projectRoot } = {}, { rebuild } = {}) {
  if (config?.workflow?.provider !== PRIVATE_SITE_PROVIDER) fail('unsupported-deployment-provider', 'not a private-site config');
  const sha = exactSha(applicationSha);
  const run = boundRun?.binding ?? boundRun;
  if (run?.provider !== PRIVATE_SITE_PROVIDER || run.headSha !== sha || run.runId !== '1') {
    fail('deployment-run-binding-mismatch', 'the private build is not bound to this commit');
  }
  const build = rebuild ?? (async (input) => (await import('../site.js')).rebuildOwnerSite(input));
  let built;
  try {
    built = await build({ config, ...(projectRoot ? { projectRoot } : {}) });
  } catch (error) {
    fail('deployment-failed', 'the private site did not build', { cause: error?.code ?? 'unknown' });
  }
  if (built?.manifest?.source?.head !== sha) {
    fail('deployment-head-mismatch', 'the private site was not built from the pushed commit');
  }
  return Object.freeze({
    provider: PRIVATE_SITE_PROVIDER,
    run: Object.freeze({ id: '1', headSha: sha, status: 'success' }),
    publication: Object.freeze({ state: 'success', site: 'private', renderer: built.manifest.renderer?.name ?? null,
      builtAt: built.manifest.builtAt ?? null }),
  });
}

/**
 * The live check against the node's own reader. `check` is the public check
 * (confirmLivePage / confirmLiveAsset); it is called with the reader address
 * as the site base, and its answer is mapped back to the identity address.
 */
export async function confirmPrivateSitePage(input, dependencies, check) {
  const { config, pageUrl } = input;
  const readerBase = await privateReaderBase(config);
  const shadow = { ...config, live: { baseUrl: readerBase } };
  const result = await check({ ...input, config: shadow, pageUrl: privateUrlFor(config, readerBase, pageUrl) }, dependencies);
  return Object.freeze({ ...result, pageUrl, servedUrl: result.pageUrl, evidence: PRIVATE_SITE_LIVE });
}

export async function confirmPrivateSiteAsset(input, dependencies, check) {
  const { config, url } = input;
  const readerBase = await privateReaderBase(config);
  const shadow = { ...config, live: { baseUrl: readerBase } };
  const result = await check({ ...input, config: shadow, url: privateUrlFor(config, readerBase, url) }, dependencies);
  return Object.freeze({ ...result, url, servedUrl: result.url, evidence: PRIVATE_SITE_LIVE });
}
