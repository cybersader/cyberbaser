export type EditLinkMode = "public" | "owner"

export interface PublicEditThisPageOptions {
  mode: "public"
  /** Repo base URL, no trailing slash, e.g. `https://github.com/cybersader/cyberbase`. */
  repoUrl: string
  /** Branch the GitHub web editor should open against. */
  branch?: string
  /** Link text. */
  text?: string
}

export interface OwnerEditThisPageOptions {
  mode: "owner"
  /** Exact privileged private-network origin, e.g. `http://127.0.0.1:4317`. */
  ownerOrigin: string
  /** Link text. */
  text?: string
}

export type EditThisPageOptions = PublicEditThisPageOptions | OwnerEditThisPageOptions

export interface EditLink {
  href: string
  external: boolean
}

/**
 * Percent-encode a repo-relative path one segment at a time so `/` survives.
 * This preserves the existing public GitHub edit URL contract.
 */
export function encodeRepoPath(relativePath: string): string {
  return relativePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/")
}

export function isTagSlug(slug: string | undefined): boolean {
  return slug === "tags" || slug?.startsWith("tags/") === true
}

/**
 * Renderer-local duplicate of owner-alpha's private-range check. This file is
 * copied into the Quartz checkout at setup time and cannot import app code,
 * so the two implementations must be kept in agreement by their tests.
 * Ranges: loopback 127/8, RFC 1918 (10/8, 172.16/12, 192.168/16), and
 * RFC 6598 shared address space 100.64/10. Exact range endpoints are rejected.
 */
export function isPrivateNetworkIpv4Host(value: string): boolean {
  if (!/^(?:(?:0|[1-9][0-9]{0,2})\.){3}(?:0|[1-9][0-9]{0,2})$/.test(value)) return false
  let numeric = 0
  for (const octet of value.split(".")) {
    const parsed = Number(octet)
    if (parsed > 255) return false
    numeric = numeric * 256 + parsed
  }
  const ranges: Array<[number, number]> = [
    [0x7f000000, 0x7fffffff], // 127.0.0.0/8
    [0x0a000000, 0x0affffff], // 10.0.0.0/8
    [0xac100000, 0xac1fffff], // 172.16.0.0/12
    [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
    [0x64400000, 0x647fffff], // 100.64.0.0/10
  ]
  return ranges.some(([low, high]) => numeric > low && numeric < high)
}

export function resolveOwnerOrigin(value: string | undefined): string {
  if (value === undefined || value === "") {
    throw new Error("CYBERBASER_OWNER_ORIGIN is required in owner edit-link mode")
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("CYBERBASER_OWNER_ORIGIN must be an exact private-network IPv4 HTTP origin")
  }
  if (url.protocol !== "http:"
    || !isPrivateNetworkIpv4Host(url.hostname)
    || url.username !== ""
    || url.password !== ""
    || url.port === ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
    || url.origin !== value) {
    throw new Error("CYBERBASER_OWNER_ORIGIN must be an exact private-network IPv4 HTTP origin")
  }
  return url.origin
}

/** Build the edit target for a real source-backed page. */
export function editLinkForPage(
  relativePath: string | undefined,
  slug: string | undefined,
  opts: EditThisPageOptions,
): EditLink | null {
  // Synthetic pages (folder indexes with no folder note, 404, tag rollups)
  // carry no source file, so there is nothing to edit.
  if (!relativePath) return null
  // Tag pages are generated from frontmatter; editing them is meaningless.
  if (isTagSlug(slug)) return null

  if (opts.mode === "owner") {
    // Owner review needs both exact source identity values. Fail closed if a
    // future synthetic page somehow has a relativePath but no slug.
    if (!slug) return null
    return {
      href: `${opts.ownerOrigin}/owner/edit?relativePath=${encodeURIComponent(relativePath)}&slug=${encodeURIComponent(slug)}`,
      external: false,
    }
  }

  const branch = opts.branch ?? "main"
  return {
    href: `${opts.repoUrl}/edit/${branch}/${encodeRepoPath(relativePath)}`,
    external: true,
  }
}

/**
 * Resolve the build-time mode. Public is the default and the only mode allowed
 * in CI, so a public build cannot silently publish owner-only routes.
 */
export function resolveEditLinkMode(
  requestedMode: string | undefined,
  ciValue: string | undefined,
): EditLinkMode {
  const mode = requestedMode === undefined || requestedMode === "" ? "public" : requestedMode
  if (mode !== "public" && mode !== "owner") {
    throw new Error(`Unsupported CYBERBASER_EDIT_LINK_MODE: ${mode}`)
  }

  const isCi = /^(1|true|yes)$/i.test(ciValue ?? "")
  if (mode === "owner" && isCi) {
    throw new Error("CYBERBASER_EDIT_LINK_MODE=owner is disabled in CI")
  }

  return mode
}
