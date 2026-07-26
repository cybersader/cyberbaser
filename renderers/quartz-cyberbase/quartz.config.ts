import { QuartzConfig } from "./quartz/cfg"
import * as Plugin from "./quartz/plugins"
import { RelativeFolderLinks } from "./quartz/cyberbase/RelativeFolderLinks"

/**
 * Quartz renderer config for the cyberbase site.
 *
 * Pinned to Quartz v4.5.2 (see README.md). Adapted from the R14 spike config
 * that rendered the vault 20/20 on the OFM conformance suite.
 *
 * Input contract: this config renders a PROJECTED copy of the vault, not the
 * vault itself. The projection has already applied the publish.yml boundary,
 * copies published files verbatim, pre-flighted bad frontmatter (Quartz has no
 * per-file error isolation: one bad YAML file aborts the whole build), and
 * injected natural-case `aliases:` entries. So ignorePatterns is a backstop
 * for stray tool directories, not the publish boundary.
 */
const config: QuartzConfig = {
  configuration: {
    pageTitle: "Cyberbase",
    pageTitleSuffix: "",
    enableSPA: true,
    enablePopovers: true,
    analytics: null,
    locale: "en-US",
    // Host + base path. Quartz takes baseUrl without a protocol; the trailing
    // path segment is the GitHub Pages project base (/cyberbase).
    baseUrl: "cybersader.github.io/cyberbase",
    // Backstop only. Globs are case-sensitive in Quartz, and the projection
    // lowercases paths, so both cases are listed where it matters.
    ignorePatterns: [".obsidian", ".git", "templates", "Templates"],
    defaultDateType: "modified",
    // Theme: "slate + emerald". Family resemblance to the cyberbaser docs site
    // (silver + emerald) without sharing any code with it — different renderer.
    // Every text-bearing token is measured against its own background; the
    // ratios are in README.md ("Theme"). Do not eyeball a replacement colour,
    // recompute it.
    theme: {
      fontOrigin: "googleFonts",
      cdnCaching: true,
      typography: {
        // IBM Plex Sans: technical without being cold, holds up at heading
        // weights, and pairs by design with IBM Plex Mono if the code font is
        // ever swapped back. Source Sans 3: the maintained successor to Source
        // Sans Pro, built for long-form screen reading (large x-height, open
        // apertures) — this vault has very long pages. JetBrains Mono: drawn
        // for code, tall x-height, unambiguous 0/O and 1/l/I, which matters in
        // a vault full of commands and hashes. All three are core Google Fonts
        // families, so the build-time fetch is not a single-family risk.
        header: "IBM Plex Sans",
        body: "Source Sans 3",
        code: "JetBrains Mono",
      },
      colors: {
        lightMode: {
          light: "#f7f8f7",
          lightgray: "#e0e4e3",
          gray: "#656f6d",
          darkgray: "#3a4442",
          dark: "#161c1b",
          secondary: "#0a6e55",
          tertiary: "#0d5a45",
          highlight: "rgba(10, 110, 85, 0.08)",
          textHighlight: "#9fe3c988",
        },
        darkMode: {
          light: "#121614",
          lightgray: "#2a312f",
          gray: "#8b9694",
          darkgray: "#c3ccca",
          dark: "#eef2f0",
          secondary: "#5ecfa4",
          tertiary: "#8fe3c0",
          highlight: "rgba(94, 207, 164, 0.10)",
          textHighlight: "#2f7d6088",
        },
      },
    },
  },
  plugins: {
    transformers: [
      Plugin.FrontMatter(),
      Plugin.CreatedModifiedDate({
        // The projection is a fresh copy with no git history, so filesystem
        // mtimes are copy times. Frontmatter dates win where present.
        priority: ["frontmatter", "git", "filesystem"],
      }),
      Plugin.SyntaxHighlighting({
        theme: {
          light: "github-light",
          dark: "github-dark",
        },
        keepBackground: false,
      }),
      Plugin.ObsidianFlavoredMarkdown({ enableInHtmlEmbed: false }),
      Plugin.GitHubFlavoredMarkdown(),
      Plugin.TableOfContents(),
      // Must run BEFORE CrawlLinks: rewrites folder-qualified relative targets
      // to root-absolute so Obsidian's page-relative semantics survive. See
      // plugins/RelativeFolderLinks.ts.
      RelativeFolderLinks(),
      Plugin.CrawlLinks({ markdownLinkResolution: "shortest" }),
      Plugin.Description(),
      Plugin.Latex({ renderEngine: "katex" }),
    ],
    filters: [Plugin.RemoveDrafts()],
    emitters: [
      // Required by the D2 URL contract: the projection injects natural-case
      // aliases and this emitter turns them into redirect stubs.
      Plugin.AliasRedirects(),
      Plugin.ComponentResources(),
      Plugin.ContentPage(),
      Plugin.FolderPage(),
      Plugin.TagPage(),
      Plugin.ContentIndex({
        enableSiteMap: true,
        enableRSS: true,
      }),
      Plugin.Assets(),
      Plugin.Static(),
      Plugin.Favicon(),
      Plugin.NotFoundPage(),
      Plugin.CustomOgImages(),
    ],
  },
}

export default config
