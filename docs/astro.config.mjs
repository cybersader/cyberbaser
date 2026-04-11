// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';
import nova from 'starlight-theme-nova';
import starlightSiteGraph from 'starlight-site-graph';
import starlightBlog from 'starlight-blog';
import starlightAnnouncement from 'starlight-announcement';
import starlightImageZoom from 'starlight-image-zoom';
// starlight-heading-badges disabled — its starlight-toc custom element
// collides with the one registered by Nova / starlight-site-graph, causing
// a NotSupportedError on page load. Re-enable only if we stop using those.
// import starlightHeadingBadges from 'starlight-heading-badges';
import starlightTagsPlugin from 'starlight-tags';
import rehypeMermaid from 'rehype-mermaid';
import remarkObsidianCallout from 'remark-obsidian-callout';
import remarkWikiLink from 'remark-wiki-link';
import rehypeExternalLinks from 'rehype-external-links';

// https://astro.build/config
export default defineConfig({
  site: 'https://cybersader.github.io',
  base: '/cyberbaser',
  vite: {
    plugins: [tailwindcss()],
    define: {
      'process.platform': '"browser"',
      'process.version': '"v0.0.0"',
      'process.env': '{}',
    },
    server: {
      // Allow access from Docker / Tailscale / LAN / cross-machine previews.
      // Vite 6+ blocks non-localhost Host headers by default.
      allowedHosts: true,
    },
  },
  markdown: {
    remarkPlugins: [
      remarkObsidianCallout,
      [remarkWikiLink, { aliasDivider: '|' }],
    ],
    rehypePlugins: [
      [rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] }],
      rehypeMermaid,
    ],
  },
  integrations: [
    starlight({
      title: 'Cyberbaser',
      logo: {
        src: './public/logo.svg',
      },
      favicon: '/favicon.svg',
      description: 'The contributable Obsidian-to-web pipeline for a distributed cybersecurity knowledge wiki.',
      lastUpdated: true,
      components: {
        MobileMenuFooter: './src/components/MobileMenuFooter.astro',
        PageTitle: './src/components/PageTitle.astro',
      },
      editLink: {
        baseUrl: 'https://github.com/cybersader/cyberbaser/edit/main/docs/',
      },
      plugins: [
        starlightAnnouncement({
          announcements: [
            {
              id: 'research-phase-2026-04',
              content: '🧠 Research & Foundations phase — building the KB from the ground up.',
              link: { text: 'See the roadmap →', href: '/cyberbaser/getting-started/roadmap/' },
              variant: 'caution',
              dismissible: true,
            },
          ],
        }),
        nova({
          nav: [
            { label: 'Docs', href: '/cyberbaser/getting-started/' },
            { label: 'Changelog', href: '/cyberbaser/changelog/' },
          ],
        }),
        starlightSiteGraph(),
        starlightBlog({
          title: 'Changelog',
          prefix: 'changelog',
        }),
        starlightImageZoom(),
        starlightTagsPlugin(),
      ],
      customCss: [
        './src/styles/global.css',
        './src/styles/brand.css',
      ],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/cybersader/cyberbaser' },
      ],
      sidebar: [
        { label: 'Getting started', autogenerate: { directory: 'getting-started' } },
        { label: 'Concepts', autogenerate: { directory: 'concepts' } },
        { label: 'Design', autogenerate: { directory: 'design' } },
        { label: 'Research', autogenerate: { directory: 'research', collapsed: true } },
        { label: 'Development', autogenerate: { directory: 'development' } },
        { label: 'Reference', autogenerate: { directory: 'reference' } },
      ],
    }),
  ],
});
