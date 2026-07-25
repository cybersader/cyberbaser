import { QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"

/**
 * "Edit this page" link — the entry point for contribution Path C (direct
 * GitHub web editor). Rendered next to ContentMeta on every page that has a
 * real source file behind it.
 *
 * This file lives in the cyberbaser repo at
 * `renderers/quartz-cyberbase/components/EditThisPage.tsx` and is copied into
 * `<quartz>/quartz/components/` by setup.sh, so its imports are written
 * relative to that destination.
 *
 * Path contract: the projection is VERBATIM (no lowercasing, no renames), so
 * `fileData.relativePath` — the path relative to the Quartz content dir — is
 * exactly the file's path inside the vault repo. Quartz sets it in
 * `quartz/processors/parse.ts` (`path.posix.relative(argv.directory, file.path)`).
 * Do NOT use `fileData.filePath`: that one is absolute (content dir prefix
 * included), and the content dir is a symlink in the bench setup.
 *
 * The repo URL is intentionally NOT hardcoded here. It is required as an
 * option so `quartz.layout.ts` declares it in exactly one place.
 */
interface EditThisPageOptions {
  /** Repo base URL, no trailing slash, e.g. `https://github.com/cybersader/cyberbase`. */
  repoUrl: string
  /** Branch the web editor should open against. */
  branch?: string
  /** Link text. */
  text?: string
}

/**
 * Percent-encode a repo-relative path, one segment at a time so `/` survives.
 * Vault paths contain emoji, spaces, commas and `&`; all of those need encoding
 * for the resulting URL to resolve.
 */
export function encodeRepoPath(relativePath: string): string {
  return relativePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/")
}

export default ((opts: EditThisPageOptions) => {
  const branch = opts.branch ?? "main"
  const label = opts.text ?? "Edit this page"

  function EditThisPage({ fileData, displayClass }: QuartzComponentProps) {
    const relativePath = fileData.relativePath
    // Synthetic pages (folder indexes with no folder note, 404, tag rollups)
    // carry no source file, so there is nothing to edit.
    if (!relativePath) return null
    // Tag pages are generated from frontmatter; editing them is meaningless.
    if (fileData.slug?.startsWith("tags/")) return null

    const href = `${opts.repoUrl}/edit/${branch}/${encodeRepoPath(relativePath)}`
    return (
      <p class={classNames(displayClass, "edit-this-page")}>
        <a href={href} target="_blank" rel="noopener noreferrer" title={relativePath}>
          <span aria-hidden="true">&#9998;</span> {label}
        </a>
      </p>
    )
  }

  // Raw CSS string (Quartz accepts `string | string[]` here). Uses the existing
  // Quartz theme variables so it needs no stylesheet of its own.
  EditThisPage.css = `
.edit-this-page {
  margin: 0.25rem 0 0 0;
  font-size: 0.8rem;
  color: var(--gray);
}
.edit-this-page a {
  color: var(--gray);
  background-color: transparent;
  text-decoration: none;
}
.edit-this-page a:hover {
  color: var(--secondary);
}
`

  return EditThisPage
}) satisfies QuartzComponentConstructor<EditThisPageOptions>
