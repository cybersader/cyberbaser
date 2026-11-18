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
import { resolveSiteBaseUrl, siteBasePath } from "./quartz/cyberbase/siteBase"

// Source of truth for the vault repo. The footer always links to the source;
// public edit mode also uses it for the existing GitHub web-editor URL.
const VAULT_REPO_URL = "https://github.com/cybersader/cyberbase"
const VAULT_REPO_BRANCH = "main"
// Source-host links (view, raw, copy, download, web editor) for every note,
// built from the vault path. View/raw pin to the vault commit being published
// so Copy Markdown matches the page; only trusted when the build runs in the
// vault repo itself or the revision is passed explicitly.
const SOURCE_HOST = githubSourceHost({
  repoUrl: VAULT_REPO_URL,
  branch: VAULT_REPO_BRANCH,
  revision: process.env.CYBERBASER_SOURCE_REVISION ||
    (process.env.GITHUB_REPOSITORY === "cybersader/cyberbase" ? process.env.GITHUB_SHA : undefined),
})

// Build-time only. Public is the fail-closed default; owner mode is an explicit
// local opt-in and is rejected in CI by resolveEditLinkMode.
const EDIT_ENTRY = resolveEditEntry(process.env.CYBERBASER_EDIT_ENTRY)
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
const EDIT_THIS_PAGE_OPTIONS: EditThisPageOptions =
  EDIT_LINK_MODE === "owner"
    ? { mode: "owner", ownerOrigin: resolveOwnerOrigin(process.env.CYBERBASER_OWNER_ORIGIN), inPlace: SUGGEST_CORRECTION_OPTIONS.enabled, editEntry: EDIT_ENTRY }
    : { mode: "public", repoUrl: VAULT_REPO_URL, branch: VAULT_REPO_BRANCH }

const SUGGEST_CORRECTION_COMPONENTS = SUGGEST_CORRECTION_OPTIONS.enabled
  ? [SuggestCorrection({ ...SUGGEST_CORRECTION_OPTIONS, editEntry: EDIT_ENTRY })]
  : []

// Cyberbase's PostHog project, carried over from publish.js at the owner's
// request. Public client key. Only the published public site counts views:
// on by default when the build runs in the vault repository, opt-in elsewhere
// with CYBERBASER_ANALYTICS=posthog, never in owner/private builds, and
// CYBERBASER_ANALYTICS=off always wins.
const ANALYTICS_SETTING = process.env.CYBERBASER_ANALYTICS
const ANALYTICS_ENABLED = EDIT_LINK_MODE === "public" && ANALYTICS_SETTING !== "off" &&
  (ANALYTICS_SETTING === "posthog" || process.env.GITHUB_REPOSITORY === "cybersader/cyberbase")
const ANALYTICS_COMPONENTS = ANALYTICS_ENABLED
  ? [Analytics(posthogProvider({
      apiKey: "phc_599knGAT15HiAYE5nHJjTqIlAY3O6e2F3QdlFzIRHKb",
      apiHost: "https://us.i.posthog.com",
      personProfiles: "identified_only",
    }))]
  : []

// 404-page forwarding for old-host URLs; only with a legacy URL snapshot.
const LEGACY_URL_COMPONENTS = process.env.CYBERBASER_LEGACY_URLS
  ? [LegacyUrlFallback({ basePath: siteBasePath(resolveSiteBaseUrl(process.env)) })]
  : []

// components shared across all pages
export const sharedPageComponents: SharedLayout = {
  head: Component.Head(),
  header: [],
  afterBody: [NoteActions({ host: SOURCE_HOST, placement: "footer" }), ...ANALYTICS_COMPONENTS, ...LEGACY_URL_COMPONENTS],
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
    NoteDates(),
    // Public builds open GitHub; private builds use the shared editor when
    // present with page provenance, otherwise the existing raw owner editor.
    EditThisPage(EDIT_THIS_PAGE_OPTIONS),
    NoteActions({ host: SOURCE_HOST, placement: "header" }),
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
    EditThisPage(EDIT_THIS_PAGE_OPTIONS),
    NoteActions({ host: SOURCE_HOST, placement: "header" }),
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
