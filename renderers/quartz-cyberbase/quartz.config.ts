import { QuartzConfig } from "./quartz/cfg"
import * as Plugin from "./quartz/plugins"

/**
 * Quartz renderer config for the cyberbase site.
 *
 * Pinned to Quartz v4.5.2 (see README.md). Adapted from the R14 spike config
 * that rendered the vault 20/20 on the OFM conformance suite.
 *
 * Input contract: this config renders a PROJECTED copy of the vault, not the
 * vault itself. The projection has already applied the publish.yml boundary,
 * lowercased every path segment, pre-flighted bad frontmatter (Quartz has no
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
    theme: {
      fontOrigin: "googleFonts",
      cdnCaching: true,
      typography: {
        header: "Schibsted Grotesk",
        body: "Source Sans Pro",
        code: "IBM Plex Mono",
      },
      colors: {
        lightMode: {
          light: "#faf8f8",
          lightgray: "#e5e5e5",
          gray: "#b8b8b8",
          darkgray: "#4e4e4e",
          dark: "#2b2b2b",
          secondary: "#284b63",
          tertiary: "#84a59d",
          highlight: "rgba(143, 159, 169, 0.15)",
          textHighlight: "#fff23688",
        },
        darkMode: {
          light: "#161618",
          lightgray: "#393639",
          gray: "#646464",
          darkgray: "#d4d4d4",
          dark: "#ebebec",
          secondary: "#7b97aa",
          tertiary: "#84a59d",
          highlight: "rgba(143, 159, 169, 0.15)",
          textHighlight: "#b3aa0288",
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
