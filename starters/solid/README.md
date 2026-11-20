# Solid static reader starter

Render a published Markdown tree as a small, read-only website. Solid components render the layout and navigation at build time; readers get ordinary HTML and CSS, with no client JavaScript or server runtime. This starter does not depend on Quartz and is not a drop-in replacement for its format or URLs.

## Build

From the repository root, with Bun 1.3.14 on a case-sensitive Linux filesystem:

```sh
bun install --cwd starters/solid --frozen-lockfile --ignore-scripts
bun run --cwd starters/solid build <projected-dir> <fresh-output-dir>
```

Use absolute paths (relative arguments are resolved from `starters/solid`). Pass the **validated projection**, not your vault, repository, or a directory containing private data. The starter trusts projection to decide what is public; it does not interpret publication flags or apply access control. Give it stable, owner-controlled input and output parents with no concurrent writers. The output's parent must exist, and the output itself must not exist, even as an empty directory or dangling symlink. The build refuses `..` in directory arguments, symlinks (including ancestors), hard-linked and special input entries, and output inside the projection. It never changes input or deletes existing output. Only serve the result after success; if an I/O failure leaves a partial output, use a different fresh path for the next build.

Try the included synthetic tree and run the tests:

```sh
bun run --cwd starters/solid build "$PWD/starters/solid/test/fixture" "$(mktemp -d)/site"
bun run --cwd starters/solid test
```

The first command prints the invoked script and output path. Serve that output directory with your usual static host (no SPA fallback needed). Serve HTML, CSS and images with their correct `Content-Type`, enable `X-Content-Type-Options: nosniff`, and mount only the generated output, never the projection.

## Pages and links

- `index.html` is the home page. A root `index.md` or a published note with `slug: index` fills it. With no home note, it shows the generated index.
- `notes/index.html` always lists all notes by projected folder. Other notes use `notes/<path-without-.md>.html`. A nonempty frontmatter `slug` substitutes its path for the default (outer slashes and a single optional `.md` or `.html` suffix are removed); route conflicts fail the build. Case, spaces, and Unicode in projected paths are preserved. URLs percent-encode each path segment once.
- **`notes.json` is the machine-readable route map.** Each row has `source` (path relative to the projection), `file` (path relative to the output, literal filename), and `url` (encoded path relative to the site base, with no leading slash). For example, a `README.md` with `slug: index` maps to `index.html`, and `guides/Field Guide.md` maps to `notes/guides/Field%20Guide.html`. The site can be mounted at a URL prefix because emitted links are relative.
- Standard Markdown links resolve against the source note's folder. `/` targets the projection root; `../` works only within the projection. Links may use a `.md` suffix or omit it, and hashes can identify rendered headings (duplicate IDs get `-1`, `-2`, and so on). Local queries do not affect resolution. Unresolved references remain readable text, not speculative URLs. External `http:` and `https:` links require a click; other schemes are not emitted.
- `[[Note]]`, `[[Note|label]]`, and `[[Note#Heading]]` support source paths, unambiguous note names and aliases (`alias` or `aliases`). Local path matches win over global name matches. Case-insensitive fallback is used only when there is no exact match and the fallback is unambiguous. Aliases resolve links but do not create redirect URLs.

## What the starter renders

CommonMark prose, tables, fenced code with language classes, and local raster images from ordinary Markdown or `![[image.png]]`. Only projected PNG, JPEG, GIF and WebP files with a matching format signature are copied to `_media/`. SVG, HTML, scripts and other attachments do not enter the output. Remote and `data:` images are not loaded. Raw HTML is shown as inert text, including HTML-placed hero images; use Markdown image syntax for a displayed image.

`%%…%%` comments in the note body are omitted from the HTML and outline, including multiline comments. Code examples can show literal delimiters, and an unclosed comment consumes the rest of the body. This is a rendering rule, **not** a publication or secrets boundary. Callouts fall back to blockquotes; note embeds become links. Block IDs, note transclusion, image sizing directives, full OFM/Quartz fidelity and old-URL continuity are not provided. There is no editor, auth, intake, or publishing action in the generated site.

## Make it yours

- [`src/Page.jsx`](src/Page.jsx): Solid components for the shell, site name, catalog, and note layout.
- [`src/reader.css`](src/reader.css): type, layout, color tokens, dark theme, and Markdown presentation.
- [`src/markdown.js`](src/markdown.js) and [`src/routes.js`](src/routes.js): optional formatting and URL conventions. Keep raw HTML disabled and preserve the local-link and media allowlists. Review compatibility before changing deployed URLs.
