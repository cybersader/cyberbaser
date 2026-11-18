/**
 * Instance settings for one Cyberbaser site, read from the vault at build time
 * (`.cyberbaser/site.yml`, passed as CYBERBASER_SITE_CONFIG). Cyberbaser keeps
 * no instance values of its own: without a settings file a build gets a
 * neutral title, no source links, no analytics and no legacy redirects.
 *
 * Pure validation; siteConfigFile.ts reads the file. Copied into `<quartz>/quartz/cyberbase/`. Validates everything and fails the
 * build on anything unexpected rather than guessing.
 */
import path from "path"

export interface SiteConfig {
  title: string
  /** Quartz baseUrl form: host plus optional path, no protocol. */
  baseUrl: string
  source?: { provider: "github"; repository: string; branch: string }
  analytics?: { provider: "posthog"; apiKey: string; apiHost: string; personProfiles: "identified_only" | "always" | "never" }
  /** Absolute path of an old-host URL snapshot (see LegacyRedirects). */
  legacyUrls?: string
  editEntry?: "auto" | "floating" | "inline"
}

export const NEUTRAL_BASE_URL = "example.com"
const KNOWN = { site: ["title", "baseUrl"], source: ["provider", "repository", "branch"], analytics: ["provider", "apiKey", "apiHost", "personProfiles"], editing: ["entry"] }

function fail(message: string): never {
  throw new Error(`site settings: ${message}`)
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== "object" || Array.isArray(value)) fail(`${name} must be a mapping`)
  const allowed = KNOWN[name as keyof typeof KNOWN]
  if (allowed) for (const key of Object.keys(value as object)) if (!allowed.includes(key)) fail(`unknown key ${name}.${key}`)
  return value as Record<string, unknown>
}

function text(value: unknown, name: string, pattern?: RegExp): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string" || value.trim() === "") fail(`${name} must be text`)
  if (pattern && !pattern.test(value)) fail(`${name} has an unexpected format: ${JSON.stringify(value)}`)
  return value.trim()
}

export function validateBaseUrl(raw: string, name = "site.baseUrl"): string {
  const value = raw.trim().replace(/\/+$/, "")
  if (!/^[a-z0-9.-]+\.[a-z]{2,}(\/[A-Za-z0-9._~-]+)*$/i.test(value) || value.split("/").some((part) => part === "." || part === "..")) {
    fail(`${name} must be host[/path] without protocol, got ${JSON.stringify(raw)}`)
  }
  return value
}

/** Validate parsed settings. `dir` resolves relative file references. */
export function parseSiteConfig(parsed: unknown, dir: string, env: Record<string, string | undefined> = {}): SiteConfig {
  const data = object(parsed, "settings")
  for (const key of Object.keys(data)) if (!["site", "source", "analytics", "legacyUrls", "editing"].includes(key)) fail(`unknown key ${key}`)
  const site = object(data.site, "site"), source = object(data.source, "source")
  const analytics = object(data.analytics, "analytics"), editing = object(data.editing, "editing")

  // Older vault workflows pass the address as CB_BASE_URL. Accept it only if
  // it agrees with the settings file, so there is one source of truth.
  const fileBase = text(site.baseUrl, "site.baseUrl")
  const envBase = env.CYBERBASER_BASE_URL || env.CB_BASE_URL
  if (fileBase && envBase && validateBaseUrl(fileBase) !== validateBaseUrl(envBase, "CB_BASE_URL")) {
    fail(`site.baseUrl (${fileBase}) and the build environment (${envBase}) disagree`)
  }
  const config: SiteConfig = {
    title: text(site.title, "site.title") ?? "Notes",
    baseUrl: validateBaseUrl(fileBase ?? envBase ?? NEUTRAL_BASE_URL),
  }
  if (Object.keys(source).length) {
    if (source.provider !== "github") fail("source.provider must be github (the only source provider today)")
    config.source = {
      provider: "github",
      repository: text(source.repository, "source.repository", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) ?? fail("source.repository is required"),
      branch: text(source.branch, "source.branch", /^[A-Za-z0-9._/-]{1,255}$/) ?? "main",
    }
    if (config.source.branch.includes("..")) fail("source.branch must not contain ..")
  }
  if (Object.keys(analytics).length) {
    if (analytics.provider !== "posthog") fail("analytics.provider must be posthog (the only analytics provider today)")
    const profiles = text(analytics.personProfiles, "analytics.personProfiles") ?? "identified_only"
    if (!["identified_only", "always", "never"].includes(profiles)) fail("analytics.personProfiles must be identified_only, always or never")
    config.analytics = {
      provider: "posthog",
      apiKey: text(analytics.apiKey, "analytics.apiKey") ?? fail("analytics.apiKey is required"),
      apiHost: text(analytics.apiHost, "analytics.apiHost") ?? fail("analytics.apiHost is required"),
      personProfiles: profiles as "identified_only" | "always" | "never",
    }
  }
  const legacy = text(data.legacyUrls, "legacyUrls")
  if (legacy) {
    if (path.isAbsolute(legacy) || legacy.split(/[\\/]/).includes("..")) fail("legacyUrls must be a path inside the settings folder")
    config.legacyUrls = path.join(dir, legacy)
  }
  const entry = text(editing.entry, "editing.entry")
  if (entry) {
    if (!["auto", "floating", "inline"].includes(entry)) fail("editing.entry must be auto, floating or inline")
    config.editEntry = entry as SiteConfig["editEntry"]
  }
  return config
}

/** True when this build runs in the site's own source repository's CI. */
export function isOwnRepositoryBuild(config: SiteConfig, env: Record<string, string | undefined>): boolean {
  return !!config.source && env.GITHUB_REPOSITORY === config.source.repository
}
