import { QuartzTransformerPlugin } from "../plugins/types"
import { FilePath, FullSlug, slugifyFilePath } from "../util/path"
import { frontmatterSlugPath } from "./frontmatterSlugCore"

/**
 * Serve a page at its frontmatter `slug:` (`slug: index` makes a note the home
 * page). Quartz derives every URL from the file path and ignores `slug`; this
 * changes only the page's URL. The file keeps its path, so source links, the
 * Edit button and owner editing still point at the real note, and its bytes
 * are untouched. The old URL stays reachable as an alias redirect.
 *
 * Must run right after FrontMatter and before anything that uses the slug
 * (links, embeds). Copied into `<quartz>/quartz/cyberbase/` by setup.sh.
 */
export const FrontmatterSlug: QuartzTransformerPlugin = () => ({
  name: "FrontmatterSlug",
  markdownPlugins(ctx) {
    return [
      () => (_tree: unknown, file: any) => {
        const target = frontmatterSlugPath(file.data.frontmatter?.slug)
        if (!target) return
        const slug = slugifyFilePath(`${target}.md` as FilePath) as FullSlug
        const current = file.data.slug as FullSlug
        if (slug === current) return
        file.data.slug = slug
        const aliases: FullSlug[] = file.data.aliases ?? []
        if (!aliases.includes(current)) aliases.push(current)
        file.data.aliases = aliases
        if (!ctx.allSlugs.includes(slug)) ctx.allSlugs.push(slug)
      },
    ]
  },
})
