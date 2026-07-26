import { QuartzTransformerPlugin } from "../plugins/types"
import { visit } from "unist-util-visit"

/**
 * Obsidian resolves a folder-qualified link like `_attachments/img.png` relative
 * to the note's own folder. Quartz v4.5.2 does not: `transformLink` compares the
 * WHOLE target against a slug's last segment, so any target containing a `/`
 * can never match the basename shortcut and always falls through to the
 * vault-root-absolute branch. The asset is emitted at the right path; only the
 * href base is wrong, which is why nothing reports it as broken.
 *
 * Measured on this vault before the fix: 1145 broken internal links, of which
 * 248 were this class (241 fixable) plus page links with the same shape.
 *
 * Fix: rewrite folder-qualified relative targets to root-absolute BEFORE
 * CrawlLinks runs, using the emitting file's own directory. That feeds Quartz's
 * existing root-absolute path the answer it should have computed.
 *
 * The `includes("/")` condition is load-bearing: bare `[[Wikilinks]]` must keep
 * resolving by basename ("shortest" mode), which is what Obsidian does for
 * unqualified names. Only qualified targets are page-relative in Obsidian.
 */
export const RelativeFolderLinks: QuartzTransformerPlugin = () => ({
  name: "RelativeFolderLinks",
  markdownPlugins() {
    return [
      () => (tree: any, file: any) => {
        const slug: string = file.data.slug ?? ""
        const dir = slug.includes("/") ? slug.slice(0, slug.lastIndexOf("/")) : ""
        if (!dir) return // a root-level note is already root-relative

        const rewrite = (url: string | undefined): string | undefined => {
          if (!url) return url
          if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url // scheme: http, mailto, data…
          if (url.startsWith("/") || url.startsWith("#")) return url
          if (url.startsWith("./") || url.startsWith("../")) return url // already explicit
          if (!url.includes("/")) return url // bare name: leave to basename resolution
          return `/${dir}/${url}`
        }

        visit(tree, ["link", "image"], (node: any) => {
          node.url = rewrite(node.url)
        })
      },
    ]
  },
})
