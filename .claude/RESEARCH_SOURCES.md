# Key Research Sources

> Pointers to the primary sources that ground cyberbaser's research & foundations phase. Organized by research task (R01–R10). When adding findings to a decision log or docs page, cite the source here.

> **Last major update:** 2026-04-13 — mined from the Cyberbase Obsidian vault (`📁 51 - Cyberbase/`), adding 200+ links across CMS, auth, sync/CRDT, SSGs, hosting, collaboration, and text editors.

---

## User's Own Work

### Live Cyberbase Content Vault
- **Repo**: https://github.com/cybersader/cyberbase
- **Description**: The actual content that cyberbaser publishes.

### Local Obsidian Research Vault
- **Path**: Local Obsidian vault (see `.claude/FOCUS.md` for path)
- **Key folders**: Contributable Obsidian Wiki/, Obsidian as a CMS/, Cyberbase Development/, Cyberbase Tech Stack/, Collaboration in Obsidian/, ✒️ Cyberbase Architecture/
- **Decision logs**: [Vault vision mining](/cyberbaser/agent-context/zz-log/2026-04-13-vault-vision-mining/) · [Vault tech stack mining](/cyberbaser/agent-context/zz-log/2026-04-13-vault-tech-stack-mining/) · [Vault collab mining](/cyberbaser/agent-context/zz-log/2026-04-13-vault-collab-mining/)

### MCP + Agent Workflow Patterns
- **Path**: Local MCP workflow project (sibling workspace)

### Sibling Projects
- **crosswalker** — https://github.com/cybersader/crosswalker (most mature `.claude/` layout, research roadmap pattern)
- **cyberchaste** — https://github.com/cybersader/cyberchaste (source of KNOWLEDGE_BASE_PHILOSOPHY, research-heavy project)
- **agentic-workflow-and-tech-stack** — https://github.com/cybersader/agentic-workflow-and-tech-stack

---

## R02 · CMS Landscape (20+ options from vault)

### Git-backed / Headless CMS
- **Decap CMS** (Open Authoring) — https://decapcms.org/ · [Open Authoring docs](https://decapcms.org/docs/open-authoring/)
- **Sveltia CMS** — https://github.com/sveltia/sveltia-cms · [Jamstack listing](https://jamstack.org/headless-cms/sveltia-cms/)
- **Tina CMS** — https://tina.io/ · [Astro integration](https://tina.io/astro) · [Self-hosted auth](https://tina.io/docs/reference/self-hosted/auth-provider/overview) · [Git providers](https://tina.io/docs/reference/self-hosted/git-provider/overview) · [DB adapters](https://tina.io/docs/reference/self-hosted/database-adapter/overview) · [Netlify Functions hosting](https://tina.io/docs/reference/self-hosted/tina-backend/netlify-functions) · [Git co-authoring](https://tina.io/docs/tina-cloud/git-co-authoring) · [Custom auth](https://tina.io/docs/reference/self-hosted/auth-provider/bring-your-own)
- **Pages CMS** — https://pagescms.org/
- **EmDash CMS** — https://github.com/emdash-cms/emdash · [Cloudflare blog announcement](https://blog.cloudflare.com/emdash-wordpress/) · [Product Hunt](https://www.producthunt.com/products/emdash-cms) · [Joost.blog review](https://joost.blog/emdash-cms/) · [Deploy on Workers guide](https://dev.classmethod.jp/en/articles/tried-emdash-astro-based-oss-cms-by-cloudflare/). **Built by Cloudflare.** Full-stack TypeScript CMS based on Astro. "Spiritual successor to WordPress." Serverless (Workers + D1 + R2). AI-agent-native: content stored as portable text (structured JSON, not HTML), designed for AI agents to read/modify content without parsing markup. Isolated plugin workers with granular permissions. Beta v0.1.0. **Very relevant** — same Astro + Cloudflare stack as cyberbaser.
- **Coisas** — https://coisas.fiatjaf.com/ (edit GitHub pages in browser via github.dev)
- **Prose** — https://github.com/prose/prose (content editor for GitHub)

### Full Headless CMS Platforms
- **Strapi** — https://strapi.io/ · [RBAC](https://strapi.io/features/custom-roles-and-permissions) · [CKEditor integration](https://strapi.io/integrations/ckeditor) · [All integrations](https://strapi.io/integrations) · [Obsidian-to-Strapi export](https://github.com/CinquinAndy/notes-to-strapi-export-article-ai) · [Cloudinary](https://market.strapi.io/providers/@strapi-provider-upload-cloudinary)
- **Sanity** — https://www.sanity.io/ · [Auth API](https://www.sanity.io/docs/auth-api-reference) · [Roles](https://www.sanity.io/docs/roles) · [Custom auth migration](https://www.sanity.io/docs/migrating-custom-auth-providers)
- **Keystone** — https://keystonejs.com/
- **Craft CMS** — https://craftcms.com/ · [Front-end user accounts](https://craftcms.com/knowledge-base/front-end-user-accounts)
- **Squidex** — https://squidex.io/
- **Prismic** — https://prismic.io/
- **Hygraph** — https://hygraph.com/
- **Magnolia** — https://www.magnolia-cms.com/
- **Gentics Mesh** — https://github.com/gentics/mesh · [Auth docs](https://www.gentics.com/mesh/docs/authentication/)
- **Contember** — https://www.contember.com/
- **Dossier** — https://www.dossierhq.dev/
- **Manifest** — https://manifest.build/
- **Flextype** — https://awilum.github.io/flextype/
- **Atomic Server** — https://atomicserver.eu/
- **Contentstack** — https://www.contentstack.com/composable-dxp
- **Kontent.ai** — https://kontent.ai/specials/what-is-composable-dxp/

### CMS Meta-Resources
- [Jamstack Headless CMS listing](https://jamstack.org/headless-cms/)
- [Jamstack SSG listing](https://jamstack.org/generators/)

---

## R03 · Auth Solutions (20+ options from vault)

- **Better-Auth** — https://www.better-auth.com/
- **Stack Auth** — https://stack-auth.com/
- **OpenAuth** — https://openauth.js.org/
- **Auth.js** — https://authjs.dev/ · [FusionAuth provider](https://authjs.dev/getting-started/providers/fusionauth)
- **Auth0** — https://auth0.com/
- **Okta** — https://www.okta.com/
- **Clerk** — https://clerk.com/ · [Pricing](https://clerk.com/pricing)
- **Ory / Kratos** — https://www.ory.sh/ · [Kratos](https://www.ory.sh/kratos/)
- **SuperTokens** — https://supertokens.com/ · [Pricing](https://supertokens.com/pricing)
- **Hanko** — https://www.hanko.io/ · [Pricing](https://www.hanko.io/pricing)
- **FusionAuth** — https://fusionauth.io/
- **Stytch** — https://stytch.com/ · [Fraud prevention](https://stytch.com/fraud)
- **Bitwarden Passwordless** — https://bitwarden.com/products/passwordless/
- **Dex** — https://dexidp.io/ (federated OIDC provider)
- **Fief** — https://docs.fief.dev/
- **Cerbos** — https://www.cerbos.dev/ · [Developer docs](https://www.cerbos.dev/for-developers)
- **Oso** — https://www.osohq.com/use-cases (authorization layer)

### Identity Providers (self-hosted)
- **Keycloak** — https://www.keycloak.org/
- **Authentik** — https://goauthentik.io/ · [Wiki.js integration](https://docs.goauthentik.io/integrations/services/wiki-js/)
- **Authelia** — https://www.authelia.com/ · [Integrations](https://www.authelia.com/integration/prologue/introduction/)

### Git Auth
- [Netlify Git Gateway](https://github.com/netlify/git-gateway) (not maintained)

---

## R05 · Collaboration & Sync (50+ links from vault)

### Live Collab Tools
- **Peerdraft** — https://www.peerdraft.app/ (real-time Obsidian collab)
- **screen.garden** — https://screen.garden/
- **obsidian-multiplayer** — https://github.com/brush701/obsidian-multiplayer
- **Self-hosted LiveSync** — https://forum.obsidian.md/t/self-hosted-livesync-ex-obsidian-livesync-released/26673
- **Etherpad** — https://github.com/ether/etherpad-lite
- **Cryptpad** — (encrypted collab editor)
- **VS Code LiveShare** + github.dev

### CRDT / OT Theory
- [crdt.tech](https://crdt.tech/) · [Implementations](https://crdt.tech/implementations)
- [Local-first software (Ink & Switch)](https://www.inkandswitch.com/local-first/)
- [CRDTs are the future (Joseph Gentle)](https://josephg.com/blog/crdts-are-the-future/)
- [CRDT vs OT (StackOverflow)](https://stackoverflow.com/questions/26694359/differences-between-ot-and-crdt)
- [CRDT vs OT (TinyMCE)](https://www.tiny.cloud/blog/real-time-collaboration-ot-vs-crdt/)
- [Why AFFiNE chose CRDT over OT](https://medium.com/@affineworkos/why-affine-chose-crdt-over-ot-to-build-a-collaborative-editor-14b05689584c)
- [Local-first is a big deal (PowerSync)](https://www.powersync.com/blog/local-first-is-a-big-deal-especially-for-the-web)
- [Creating the local-first stack](https://dev.to/ebuckley/creating-the-local-first-stack-4aki)
- [Comparing local-first frameworks](https://dev.to/neon-postgres/comparing-local-first-frameworks-and-approaches-1hgn)
- [Recapping the first Local-First conference](https://evilmartians.com/chronicles/recapping-the-first-local-first-conference-in-15-minutes)
- [Downsides of offline-first (RxDB)](https://rxdb.info/downsides-of-offline-first.html)
- [Tonsky on local-first CRDT filesync](https://tonsky.me/blog/crdt-filesync/)

### CRDT / Sync Libraries
- **Yjs** — https://yjs.dev/ · https://github.com/yjs/yjs
- **Automerge** — https://automerge.org/ · [Automerge 2.0](https://automerge.org/blog/automerge-2/)
- **SyncedStore** — https://syncedstore.org/docs/
- **ShareDB** — https://github.com/share/sharedb (OT-based)
- **trpc-crdt** — https://github.com/KyleAMathews/trpc-crdt

### Content Editing Frameworks (CRDT-native)
- **BlockSuite** — https://blocksuite.io/ (from AFFiNE) · [CRDT-native data flow](https://block-suite.com/blog/crdt-native-data-flow.html) · [Data sync](https://block-suite.com/guide/data-synchronization.html) · [Store](https://blocksuite.io/guide/store.html)
- **OctoBase** — https://octobase.dev/ (CRDT database from AFFiNE) · [Sync connector](https://octobase.dev/docs/implementation/connector)
- **Convergence** — https://convergence.io/

### Sync Engines
- **ElectricSQL** — https://electric-sql.com/
- **PowerSync** — https://www.powersync.com/
- **RxDB** — https://rxdb.info/offline-first.html
- **Turso** — https://turso.tech/local-first
- [Building an offline realtime sync engine (gist)](https://gist.github.com/pesterhazy/3e039677f2e314cb77ffe3497ebca07b)

### Text / Code Editors
- **CKEditor** — https://ckeditor.com/
- **Tiptap** — https://tiptap.dev/product/collaboration
- **Conclave** — https://conclave-team.github.io/conclave/ · [Building Conclave](https://hackernoon.com/building-conclave-a-decentralized-real-time-collaborative-text-editor-a6ab438fe79f)
- **Banger Editor** (Bangle.io) — https://github.com/bangle-io/banger-editor

### Note-Taking Apps with Collab (reference implementations)
- **AFFiNE** — https://github.com/toeverything/AFFiNE (BlockSuite + OctoBase)
- **AppFlowy** — https://docs.appflowy.io/
- **Outline** — https://docs.getoutline.com/s/guide/doc/collaborative-editing-GjkoCop1B7
- **Boost Note** — https://boostnote.io/ · [Real-time coauthoring](https://boostnote.io/features/coauthoring)
- **Standard Notes** — https://standardnotes.com/ (no collab)
- **Bangle.io** — https://bangle.io/ (local WYSIWYG on markdown)

### Git-Based Collab
- **Sturdy** — https://github.com/sturdy-dev/sturdy
- **Radicle** — https://radicle.xyz/ (P2P git forge)
- **Gitea** — https://about.gitea.com/
- **Gogs** — https://gogs.io/
- **Filestash** — https://www.filestash.app/
- **Pears Protocol** — https://docs.pears.com/ (P2P directory sync)

### Databases / Data Infrastructure
- **Supabase** — https://supabase.com/
- **SurrealDB** — https://surrealdb.com/
- **GunJS** — https://gun.js.org/ (decentralized DB)
- **ArangoDB** — https://arangodb.com/document-store/
- **CouchDB** — [Conflict resolution with Svelte](https://neighbourhood.ie/blog/2024/12/11/automatic-conflict-resolution/)
- **RethinkDB** — https://rethinkdb.com/

---

## R06 · Translation Layer

- **unified / remark / rehype** — https://unifiedjs.com/
- **remark-wiki-link** — https://github.com/landakram/remark-wiki-link
- **remark-obsidian-callout** — (npm package, used in current build)
- **astro-loader-obsidian** — https://github.com/aitorllj93/astro-loader-obsidian (current dep)
- **starlight-theme-obsidian** — https://github.com/Fevol/starlight-theme-obsidian
- **Obsidian Flavored Markdown spec** — https://help.obsidian.md/Editing+and+formatting/Obsidian+Flavored+Markdown
- **CommonMark** — https://commonmark.org/
- **Markdoc** — https://markdoc.dev/ (alternative content authoring format)
- [Write Like a Pro with Astro and Obsidian](https://www.hungrimind.com/articles/obsidian-with-astro)
- [awesome-markdown-editors](https://github.com/mundimark/awesome-markdown-editors)
- **obsidian-static-site-export** — https://github.com/yy4382/obsidian-static-site-export
- **obsidian-markdown-blogger** — https://github.com/afazio1/obsidian-markdown-blogger
- **Obsidian Enveloppe** — https://github.com/Enveloppe/obsidian-enveloppe (publish to GitHub)
- [A lazy man's Obsidian + Astro workflow](https://www.reddit.com/r/ObsidianMD/comments/1943yza/a_lazy_mans_obsidian_astro_workflow_integration/)

---

## R07 · Publish Site Examples (60+ in vault)

Located in vault: `📁 51 - Cyberbase/Cyberbase Obsidian Publish/`. Key examples:
- Obsidian Hub (community standard)
- Data Engineering Wiki (contributable model)
- SlRvb's ITS Theme showcase
- *(Full list to be inventoried in a dedicated research page)*

---

## R08 · Hosting & Infrastructure

- **Cloudflare Pages** (current) — https://pages.cloudflare.com/ · [Framework guides](https://developers.cloudflare.com/pages/framework-guides/)
- **Netlify** — https://docs.netlify.com/ · [Astro guide](https://docs.netlify.com/frameworks/astro/)
- **GitHub Pages** — https://pages.github.com/
- **GitLab Pages** — https://docs.gitlab.com/ee/user/project/pages/
- **Vercel** — https://vercel.com/pricing
- **Firebase** — https://firebase.google.com/
- **DigitalOcean** — https://www.digitalocean.com/pricing
- **Appwrite** — https://appwrite.io/
- **Sevalla** — https://sevalla.com/

### Static Website Services
- [Staticman](https://staticman.net/) — static site superpowers
- [awesome-static-website-services](https://github.com/agarrharr/awesome-static-website-services)
- [Stable URLs on Obsidian Publish](https://joschua.io/posts/2023/10/07/stable-publish-urls)

### Misc Infrastructure
- **tus.io** — https://tus.io/ (resumable uploads)
- **Kong API Gateway** — https://sgnl.ai/2023/09/kong-api-gateway-authorization/
- **Podman** — https://podman.io/ (containers)
- **WebRTC** — https://webrtc.org/
- **Prisma** — https://www.prisma.io/ (ORM)
- **Hasura** — https://hasura.io/ · [CouchDB-style sync](https://hasura.io/blog/couchdb-style-conflict-resolution-rxdb-hasura)

---

## R09 · SEO

Located in vault: `📁 51 - Cyberbase/Obsidian Publish SEO/`
*(To be inventoried in a dedicated research page)*

---

## R10 · Inline Editing / Text Editors

- **Prose** — https://github.com/prose/prose (GitHub content editor)
- **CKEditor** — https://ckeditor.com/
- **Tiptap** — https://tiptap.dev/product/collaboration
- **BlockSuite** — https://blocksuite.io/ (CRDT-native, from AFFiNE)
- **TeleportHQ** — https://teleporthq.io/ (low-code front-end)
- **Bangle.io** — https://bangle.io/ (WYSIWYG on markdown)
- **Conclave** — https://conclave-team.github.io/conclave/ (decentralized real-time editor)
- **Code-Sync** — https://github.com/sahilatahar/Code-Sync
- **Digital Garden plugin** — https://dg-docs.ole.dev/
- **Bear Blog** — https://bearblog.dev/

---

## People / Communities

- TODO: add maintainers, blogs, Discord communities as research surfaces them.
