import { QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"
import { editLinkForPage } from "./editLink"
import type { EditThisPageOptions } from "./editLink"
export { encodeRepoPath } from "./editLink"

/**
 * "Edit this page" link for either the public GitHub editor or the local owner
 * route. Rendered next to ContentMeta on every page that has a real source file
 * behind it.
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
 * Public mode keeps the existing GitHub editor behavior. Owner mode points to
 * the separately-originated privileged owner route and carries the exact source
 * path and page slug. The mode is selected once in `quartz.layout.ts` at build time.
 */

export default ((opts: EditThisPageOptions) => {
  const label = opts.text ?? "Edit this page"

  function EditThisPage({ fileData, displayClass }: QuartzComponentProps) {
    const relativePath = fileData.relativePath
    const link = editLinkForPage(relativePath, fileData.slug, opts)
    if (!link) return null

    const externalProps = link.external
      ? { target: "_blank", rel: "noopener noreferrer" }
      : undefined
    return (
      <p class={classNames(displayClass, "edit-this-page")}>
        <a href={link.href} {...externalProps} title={relativePath}>
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
