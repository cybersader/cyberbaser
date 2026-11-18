/**
 * Site address for the build: Quartz `baseUrl` form (host plus optional path,
 * no protocol). Set CYBERBASER_BASE_URL (or the vault workflow's existing
 * CB_BASE_URL) to publish on a custom domain; the default keeps the current
 * GitHub Pages project site. Copied into `<quartz>/quartz/cyberbase/`.
 */
export const DEFAULT_BASE_URL = "cybersader.github.io/cyberbase"

export function resolveSiteBaseUrl(env: Record<string, string | undefined>): string {
  const raw = (env.CYBERBASER_BASE_URL || env.CB_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "")
  if (!/^[a-z0-9.-]+\.[a-z]{2,}(\/[A-Za-z0-9._~-]+)*$/i.test(raw) || raw.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`site base URL must be host[/path] without protocol, got ${JSON.stringify(raw)}`)
  }
  return raw
}

/** Path prefix of the site, "" at a domain root or "/cyberbase" for a project site. */
export function siteBasePath(baseUrl: string): string {
  const slash = baseUrl.indexOf("/")
  return slash < 0 ? "" : baseUrl.slice(slash)
}
