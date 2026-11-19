/**
 * The page path a frontmatter `slug:` names, without extension, or undefined
 * when it is not a plain relative path. Same rules as the projection's
 * slugTarget (packages/projection/src/project.js), which fails the build on a
 * malformed or taken slug before the renderer runs.
 */
export function frontmatterSlugPath(slug: unknown): string | undefined {
  if (typeof slug !== "string") return undefined
  const s = slug.trim().replace(/^\/+|\/+$/g, "").replace(/\.(md|html)$/i, "")
  if (s === "" || s.includes("\\") || /[\u0000-\u001F\u007F]/.test(s)) return undefined
  const parts = s.split("/")
  if (parts.some((x) => x === "" || x === "." || x === ".." || x.trim() !== x)) return undefined
  return s
}
