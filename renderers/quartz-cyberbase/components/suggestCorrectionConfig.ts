import { createHash } from "node:crypto"

export const SUGGEST_CORRECTION_ENABLE_VALUE = "enabled"
export const ACCOUNT_FREE_INTAKE_PATH = "/v1/corrections"
export const ACCOUNT_FREE_INTENT_ARTIFACT_TYPE = "cyberbaser-account-free-correction-intent"
export const ACCOUNT_FREE_INTENT_SCHEMA_VERSION = 1

const DIGEST_RE = /^sha-256=:([A-Za-z0-9+/]{43}=):$/u
const PAGE_ID_RE = /^page-v1:[A-Za-z0-9_-]{43}$/u
const CONTROL_RE = /[\x00-\x1f\x7f]/u

export interface SuggestCorrectionDisabledOptions {
  enabled: false
}

export interface SuggestCorrectionEnabledOptions {
  enabled: true
  intakeOrigin: string
  bindingDigest: string
  sourceRepository: string
  sourceRevision: string
  text?: string
}

export type SuggestCorrectionOptions =
  | SuggestCorrectionDisabledOptions
  | SuggestCorrectionEnabledOptions

export interface SuggestCorrectionEnvironment {
  enabled: string | undefined
  intakeOrigin: string | undefined
  bindingDigest: string | undefined
  sourceRepository: string | undefined
  sourceRevision: string | undefined
}

export interface PublicSuggestionBinding {
  action: string
  bindingDigest: string
  pageId: string
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === "") {
    throw new Error(`${name} is required when SuggestCorrection is enabled`)
  }
  return value
}

function canonicalHttpsUrl(value: string, name: string, repository = false): string {
  if (Buffer.byteLength(value, "utf8") > 2 * 1024 || Buffer.from(value, "utf8").toString("utf8") !== value) {
    throw new Error(`${name} must be a bounded canonical credential-free HTTPS URL`)
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be a canonical credential-free HTTPS URL`)
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.hostname.endsWith(".")
    || url.search !== ""
    || url.hash !== ""
    || url.toString() !== value
    || /%(?![0-9A-Fa-f]{2})/u.test(value)
  ) {
    throw new Error(`${name} must be a canonical credential-free HTTPS URL`)
  }
  for (const match of value.matchAll(/%([0-9A-Fa-f]{2})/gu)) {
    const hex = match[1]
    const character = String.fromCharCode(Number.parseInt(hex, 16))
    if (hex !== hex.toUpperCase() || /[A-Za-z0-9._~-]/u.test(character)) {
      throw new Error(`${name} must use one canonical percent-encoding spelling`)
    }
  }
  if (repository && (url.pathname === "/" || url.pathname.endsWith("/") || url.pathname.includes("//"))) {
    throw new Error(`${name} must name one unambiguous repository path`)
  }
  return value
}

export function resolveIntakeOrigin(value: string | undefined): string {
  const origin = required(value, "CYBERBASER_ACCOUNT_FREE_INTAKE_ORIGIN")
  if (Buffer.byteLength(origin, "utf8") > 2 * 1024 || Buffer.from(origin, "utf8").toString("utf8") !== origin) {
    throw new Error("CYBERBASER_ACCOUNT_FREE_INTAKE_ORIGIN must be one exact canonical HTTPS origin")
  }
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    throw new Error("CYBERBASER_ACCOUNT_FREE_INTAKE_ORIGIN must be one exact canonical HTTPS origin")
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.hostname.endsWith(".")
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
    || url.origin !== origin
  ) {
    throw new Error("CYBERBASER_ACCOUNT_FREE_INTAKE_ORIGIN must be one exact canonical HTTPS origin")
  }
  return origin
}

export function requireBindingDigest(value: string | undefined): string {
  const digest = required(value, "CYBERBASER_ACCOUNT_FREE_BINDING_DIGEST")
  const match = digest.match(DIGEST_RE)
  if (!match) {
    throw new Error("CYBERBASER_ACCOUNT_FREE_BINDING_DIGEST must be an RFC-9530-style SHA-256 digest")
  }
  const bytes = Buffer.from(match[1], "base64")
  if (bytes.length !== 32 || bytes.toString("base64") !== match[1]) {
    throw new Error("CYBERBASER_ACCOUNT_FREE_BINDING_DIGEST must be an RFC-9530-style SHA-256 digest")
  }
  return digest
}

export function requireSourceRepository(value: string | undefined): string {
  return canonicalHttpsUrl(
    required(value, "CYBERBASER_ACCOUNT_FREE_SOURCE_REPOSITORY"),
    "CYBERBASER_ACCOUNT_FREE_SOURCE_REPOSITORY",
    true,
  )
}

export function requireSourceRevision(value: string | undefined): string {
  const revision = required(value, "CYBERBASER_ACCOUNT_FREE_SOURCE_REVISION")
  if (
    Buffer.byteLength(revision, "utf8") > 1024
    || Buffer.from(revision, "utf8").toString("utf8") !== revision
    || CONTROL_RE.test(revision)
  ) {
    throw new Error("CYBERBASER_ACCOUNT_FREE_SOURCE_REVISION must be a bounded opaque immutable identifier")
  }
  return revision
}

export function requireSourcePath(value: string): string {
  if (
    value === ""
    || Buffer.byteLength(value, "utf8") > 4096
    || Buffer.from(value, "utf8").toString("utf8") !== value
    || CONTROL_RE.test(value)
    || value.startsWith("/")
    || value.includes("\\")
    || !value.endsWith(".md")
  ) {
    throw new Error("source path must be a repository-relative POSIX Markdown path")
  }
  const segments = value.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..") || segments.includes(".git")) {
    throw new Error("source path contains a forbidden path segment")
  }
  return value
}

function lengthPrefixedTuple(values: string[]): Buffer {
  const parts: Buffer[] = []
  for (const value of values) {
    const bytes = Buffer.from(value, "utf8")
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(bytes.length)
    parts.push(length, bytes)
  }
  return Buffer.concat(parts)
}

/** Match @cyberbaser/account-free-intake's opaque page-v1 identity exactly. */
export function computePageId({
  repository,
  revision,
  path,
}: {
  repository: string
  revision: string
  path: string
}): string {
  const normalizedRepository = requireSourceRepository(repository)
  const normalizedRevision = requireSourceRevision(revision)
  const normalizedPath = requireSourcePath(path)
  const digest = createHash("sha256").update(lengthPrefixedTuple([
    "cyberbaser-page-v1",
    normalizedRepository,
    normalizedRevision,
    normalizedPath,
  ])).digest("base64url")
  return `page-v1:${digest}`
}

export function resolveSuggestCorrectionOptions(
  env: SuggestCorrectionEnvironment,
): SuggestCorrectionOptions {
  const requested = env.enabled ?? ""
  if (requested === "") return { enabled: false }
  if (requested !== SUGGEST_CORRECTION_ENABLE_VALUE) {
    throw new Error(
      `CYBERBASER_ACCOUNT_FREE_INTAKE must be unset or '${SUGGEST_CORRECTION_ENABLE_VALUE}'`,
    )
  }
  return {
    enabled: true,
    intakeOrigin: resolveIntakeOrigin(env.intakeOrigin),
    bindingDigest: requireBindingDigest(env.bindingDigest),
    sourceRepository: requireSourceRepository(env.sourceRepository),
    sourceRevision: requireSourceRevision(env.sourceRevision),
  }
}

function isTagSlug(slug: string | undefined): boolean {
  return slug === "tags" || slug?.startsWith("tags/") === true
}

/** Return only the three public values the browser needs. */
export function suggestionBindingForPage(
  relativePath: string | undefined,
  slug: string | undefined,
  opts: SuggestCorrectionOptions,
): PublicSuggestionBinding | null {
  if (!opts.enabled || !relativePath || isTagSlug(slug)) return null
  const pageId = computePageId({
    repository: opts.sourceRepository,
    revision: opts.sourceRevision,
    path: relativePath,
  })
  if (!PAGE_ID_RE.test(pageId)) throw new Error("computed page ID is invalid")
  return {
    action: `${opts.intakeOrigin}${ACCOUNT_FREE_INTAKE_PATH}`,
    bindingDigest: opts.bindingDigest,
    pageId,
  }
}
