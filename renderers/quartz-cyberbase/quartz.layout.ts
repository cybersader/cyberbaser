import { PageLayout, SharedLayout } from "./quartz/cfg"
import * as Component from "./quartz/components"
// Cyberbaser-local component and helper, copied in by setup.sh (not upstream Quartz).
import EditThisPage from "./quartz/components/EditThisPage"
import { resolveEditLinkMode, resolveOwnerOrigin } from "./quartz/components/editLink"
import type { EditThisPageOptions } from "./quartz/components/editLink"
import { resolveEditEntry } from "./quartz/components/editEntryConfig"
import SuggestCorrection from "./quartz/components/SuggestCorrection"
import { resolveSuggestCorrectionOptions } from "./quartz/components/suggestCorrectionConfig"
import NoteActions from "./quartz/components/NoteActions"
import NoteDates from "./quartz/components/NoteDates"
import { githubSourceHost } from "./quartz/components/sourceLinks"
import Analytics from "./quartz/components/Analytics"
import { posthogProvider } from "./quartz/components/analyticsProviders"
import LegacyUrlFallback from "./quartz/components/LegacyUrlFallback"
import { siteBasePath } from "./quartz/cyberbase/siteBase"
import { isOwnRepositoryBuild } from "./quartz/cyberbase/siteConfig"
import { loadSiteConfig } from "./quartz/cyberbase/siteConfigFile"

// Everything instance-specific comes from the vault's settings file
// (.cyberbaser/site.yml, see siteConfig.ts). Without it: no source links,
// no analytics, no legacy redirects.
const SITE = loadSiteConfig(process.env)
const OWN_REPOSITORY_BUILD = isOwnRepositoryBuild(SITE, process.env)

// Source-host links (view, raw, copy, download, web editor) for every note,
// built from the vault path. View/raw pin to the commit being published so
// Copy Markdown matches the page; trusted only when the build runs in the
// source repository itself or the revision is passed explicitly.
const SOURCE_REPO_URL = SITE.source ? `https://github.com/${SITE.source.repository}` : undefined
const SOURCE_HOST = SITE.source
  ? githubSourceHost({
      repoUrl: SOURCE_REPO_URL!,
      branch: SITE.source.branch,
      revision: process.env.CYBERBASER_SOURCE_REVISION || (OWN_REPOSITORY_BUILD ? process.env.GITHUB_SHA : undefined),
    })
  : undefined
const NOTE_ACTIONS_HEADER = SOURCE_HOST ? [NoteActions({ host: SOURCE_HOST, placement: "header" })] : []
const NOTE_ACTIONS_FOOTER = SOURCE_HOST ? [NoteActions({ host: SOURCE_HOST, placement: "footer" })] : []

// Build-time only. Public is the fail-closed default; owner mode is an explicit
// local opt-in and is rejected in CI by resolveEditLinkMode. The owner app's
// own setting wins over the site file for edit-button placement.
const EDIT_ENTRY = resolveEditEntry(process.env.CYBERBASER_EDIT_ENTRY || SITE.editEntry)
const EDIT_LINK_MODE = resolveEditLinkMode(process.env.CYBERBASER_EDIT_LINK_MODE, process.env.CI)
// Account-free suggestions are a separate public proposal spoke. They remain
// absent unless every retained-publication input is supplied with an explicit
// build-time opt-in. None of these private binding inputs are rendered directly.
const SUGGEST_CORRECTION_OPTIONS = resolveSuggestCorrectionOptions({
  enabled: process.env.CYBERBASER_ACCOUNT_FREE_INTAKE,
  intakeOrigin: process.env.CYBERBASER_ACCOUNT_FREE_INTAKE_ORIGIN,
  bindingDigest: process.env.CYBERBASER_ACCOUNT_FREE_BINDING_DIGEST,
  sourceRepository: process.env.CYBERBASER_ACCOUNT_FREE_SOURCE_REPOSITORY,
  sourceRevision: process.env.CYBERBASER_ACCOUNT_FREE_SOURCE_REVISION,
  challengeSiteKey: process.env.CYBERBASER_SUGGESTION_CHALLENGE_SITE_KEY,
  challengeProvider: process.env.CYBERBASER_SUGGESTION_CHALLENGE_PROVIDER,
})
// Public builds without a source repository have no edit link at all.
const EDIT_THIS_PAGE_OPTIONS: EditThisPageOptions | undefined =
  EDIT_LINK_MODE === "owner"
    ? { mode: "owner", ownerOrigin: resolveOwnerOrigin(process.env.CYBERBASER_OWNER_ORIGIN), inPlace: SUGGEST_CORRECTION_OPTIONS.enabled, editEntry: EDIT_ENTRY }
    : SITE.source ? { mode: "public", repoUrl: SOURCE_REPO_URL!, branch: SITE.source.branch } : undefined
const EDIT_THIS_PAGE = EDIT_THIS_PAGE_OPTIONS ? [EditThisPage(EDIT_THIS_PAGE_OPTIONS)] : []

const SUGGEST_CORRECTION_COMPONENTS = SUGGEST_CORRECTION_OPTIONS.enabled
  ? [SuggestCorrection({ ...SUGGEST_CORRECTION_OPTIONS, editEntry: EDIT_ENTRY })]
  : []

// Analytics from the site settings count only the published public site: on
// when the build runs in the site's own source repository, opt-in elsewhere
// with CYBERBASER_ANALYTICS=on, never in owner/private builds, and
// CYBERBASER_ANALYTICS=off always wins.
const ANALYTICS_SETTING = process.env.CYBERBASER_ANALYTICS
const ANALYTICS_ENABLED = !!SITE.analytics && EDIT_LINK_MODE === "public" && ANALYTICS_SETTING !== "off" &&
  (ANALYTICS_SETTING === "on" || OWN_REPOSITORY_BUILD)
const ANALYTICS_COMPONENTS = ANALYTICS_ENABLED ? [Analytics(posthogProvider(SITE.analytics!))] : []

// 404-page forwarding for old-host URLs; only with a legacy URL snapshot.
const LEGACY_URL_COMPONENTS = SITE.legacyUrls ? [LegacyUrlFallback({ basePath: siteBasePath(SITE.baseUrl) })] : []

// components shared across all pages
export const sharedPageComponents: SharedLayout = {
  head: Component.Head(),
  header: [],
  afterBody: [...NOTE_ACTIONS_FOOTER, ...ANALYTICS_COMPONENTS, ...LEGACY_URL_COMPONENTS],
  footer: Component.Footer({
    links: {
      ...(SOURCE_REPO_URL ? { Source: SOURCE_REPO_URL } : {}),
      "Built with Cyberbaser": "https://github.com/cybersader/cyberbaser",
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
    NoteDates(),
    // Public builds open GitHub; private builds use the shared editor when
    // present with page provenance, otherwise the existing raw owner editor.
    ...EDIT_THIS_PAGE,
    ...NOTE_ACTIONS_HEADER,
    ...SUGGEST_CORRECTION_COMPONENTS,
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
    NoteDates(),
    ...EDIT_THIS_PAGE,
    ...NOTE_ACTIONS_HEADER,
    ...SUGGEST_CORRECTION_COMPONENTS,
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
