import { PageLayout, SharedLayout } from "./quartz/cfg"
import * as Component from "./quartz/components"
// Cyberbaser-local component, copied in by setup.sh (not part of upstream Quartz).
import EditThisPage from "./quartz/components/EditThisPage"

// Source of truth for the vault repo. Declared once; the footer link and the
// "Edit this page" link both read it, so there is no second copy to drift.
const VAULT_REPO_URL = "https://github.com/cybersader/cyberbase"
const VAULT_REPO_BRANCH = "main"

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
    // Contribution Path C entry point: opens the file in GitHub's web editor.
    EditThisPage({ repoUrl: VAULT_REPO_URL, branch: VAULT_REPO_BRANCH }),
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
    EditThisPage({ repoUrl: VAULT_REPO_URL, branch: VAULT_REPO_BRANCH }),
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
