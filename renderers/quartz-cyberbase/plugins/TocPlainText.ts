import { QuartzTransformerPlugin } from "../plugins/types"
import { visit } from "unist-util-visit"
import GithubSlugger from "github-slugger"
import { tocPlainText } from "./tocPlainTextCore"

/**
 * Quartz's table of contents takes heading text from the markdown source, so a
 * heading with an inline icon (`## <img src="…github.svg"> Base Source`, common
 * in Obsidian notes) shows the raw tag in the TOC and links to an anchor that
 * does not exist. This runs after TableOfContents and rebuilds those entries
 * from the heading's visible text, with anchors computed the way the heading
 * ids are.
 *
 * Copied into `<quartz>/quartz/cyberbase/` by setup.sh.
 */
export const TocPlainText: QuartzTransformerPlugin = () => ({
  name: "TocPlainText",
  markdownPlugins() {
    return [
      () => (tree: any, file: any) => {
        const toc = file.data.toc as { depth: number; text: string; slug: string }[] | undefined
        if (!toc?.some((entry) => entry.text.includes("<"))) return
        const headings: { depth: number; parts: { type: string; value?: string }[] }[] = []
        visit(tree, "heading", (node: any) => {
          const parts: { type: string; value?: string }[] = []
          visit(node, (child: any) => {
            if (child.type === "text" || child.type === "inlineCode") parts.push({ type: "text", value: child.value })
            else if (child.type === "html") parts.push({ type: "html", value: child.value })
          })
          headings.push({ depth: node.depth, parts })
        })
        const slugger = new GithubSlugger()
        file.data.toc = tocPlainText(toc, headings, (text) => slugger.slug(text))
      },
    ]
  },
})
