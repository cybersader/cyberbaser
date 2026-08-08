import { PageLayout, SharedLayout } from "./quartz/cfg"
import * as Component from "./quartz/components"
// Cyberbaser-local component and helper, copied in by setup.sh (not upstream Quartz).
import EditThisPage from "./quartz/components/EditThisPage"
import { resolveEditLinkMode, resolveOwnerOrigin } from "./quartz/components/editLink"
import type { EditThisPageOptions } from "./quartz/components/editLink"

// Source of truth for the vault repo. The footer always links to the source;
// public edit mode also uses it for the existing GitHub web-editor URL.
const VAULT_REPO_URL = "https://github.com/cybersader/cyberbase"
const VAULT_REPO_BRANCH = "main"

// Build-time only. Public is the fail-closed default; owner mode is an explicit
// local opt-in and is rejected in CI by resolveEditLinkMode.
const EDIT_LINK_MODE = resolveEditLinkMode(process.env.CYBERBASER_EDIT_LINK_MODE, process.env.CI)
const EDIT_THIS_PAGE_OPTIONS: EditThisPageOptions =
  EDIT_LINK_MODE === "owner"
    ? { mode: "owner", ownerOrigin: resolveOwnerOrigin(process.env.CYBERBASER_OWNER_ORIGIN) }
    : { mode: "public", repoUrl: VAULT_REPO_URL, branch: VAULT_REPO_BRANCH }

// components shared across all pages
export const sharedPageComponents: SharedLayout = {
  head: Component.Head(),
  header: [],
  afterBody: [],
  footer: Component.Footer({
    links: {
      Vault: VAULT_REPO_URL,
      Cyberbaser: "https://github.com/cybersader/cyberbaser",
    },
  }),
}

// components for pages that display a single page (e.g. a single note)
export const defaultContentPageLayout: PageLayout = {
  beforeBody: [
    Component.ConditionalRender({
      component: Component.Breadcrumbs(),
      condition: (page) => page.fileData.slug !== "index",
    }),
    Component.ArticleTitle(),
    Component.ContentMeta(),
    // Public builds open GitHub; explicit local owner builds open /owner/edit.
    EditThisPage(EDIT_THIS_PAGE_OPTIONS),
    Component.TagList(),
  ],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.Darkmode() },
        { Component: Component.ReaderMode() },
      ],
    }),
    Component.Explorer(),
  ],
  right: [
    Component.Graph(),
    Component.DesktopOnly(Component.TableOfContents()),
    Component.Backlinks(),
  ],
}

// components for pages that display lists of pages (e.g. tags or folders)
export const defaultListPageLayout: PageLayout = {
  // Folder and tag pages share this layout. EditThisPage renders nothing on
  // synthetic pages (no source file) and self-skips tag pages, so folder notes
  // get the link and generated index pages do not.
  beforeBody: [
    Component.Breadcrumbs(),
    Component.ArticleTitle(),
    Component.ContentMeta(),
    EditThisPage(EDIT_THIS_PAGE_OPTIONS),
  ],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.Darkmode() },
      ],
    }),
    Component.Explorer(),
  ],
  right: [],
}
