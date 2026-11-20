# Two site starters, one publication policy

From a Cyberbaser checkout on Linux, with **Bun 1.3.11, Node 22+, npm, Git and Bash**, run:

```sh
bash starters/build.sh both
```

The first build needs internet access for locked dependencies, pinned Quartz and its build assets. `quartz` and `solid` also work individually; choosing Solid does not install or run Quartz. This is a checkout-based starter, not a published CLI. Both consume the same selected files (not the source checkout). The private projection report and temporary engine are outside the output. Only serve one renderer’s output directory, never the vault, working directory or reports.

Preview either build locally: `python3 -I starters/preview.py starter-output/quartz` (or use `starter-output/solid`). Open `http://127.0.0.1:8080/`. The preview resolves Pages-style clean URLs, binds only to loopback and never deploys anything.

| Start with | Change first | Reader features |
|---|---|---|
| [Quartz notebook](quartz/) | `quartz/site.yml`, `quartz/trail.css`, the shared homepage note | Existing Cyberbaser adapter for Quartz, including its wiki navigation and Markdown extensions |
| [Solid reader](solid/) | Solid page components and reader styles | Independent static reader; see its README for supported Markdown, links and limits |

To build a trusted vault, pass its path and a **new** output directory in an existing parent: `bash starters/build.sh both /path/to/vault ./my-sites`. The bundled example includes an explicit deny inside the allowed folder, an unlisted note and an unreferenced asset so you can verify that *not* publishing something works. These are read-only readers, not public authoring services. A renderer is not a security sandbox for untrusted plugins, styles, or active content.

**Acceptance:** CI tests publication and projection, both renderers, and documentation. It inspects both emitted trees, follows a link and decodes an image on desktop and mobile Chromium, and checks refused/failed builds. CI uses synthetic content only, with no write scopes or deployments. For the same fixture test locally, install the locked `docs` dependencies and Playwright Chromium, then run `bash starters/tests/check.sh`.
