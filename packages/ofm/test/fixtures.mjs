// The hardest Obsidian-Flavored-Markdown (OFM) round-trip cases.
// Each fixture is a minimal snippet that must survive: parse -> mdast -> stringify === original.
export const fixtures = [
  // --- wikilinks ---
  { name: 'wikilink-plain', tier: 1, src: 'See [[Some Page]] for details.\n' },
  { name: 'wikilink-alias', tier: 1, src: 'See [[Some Page|the alias]] here.\n' },
  { name: 'wikilink-heading', tier: 1, src: 'Jump to [[Some Page#A Heading]].\n' },
  { name: 'wikilink-blockref', tier: 1, src: 'Quote [[Some Page#^block-id]] inline.\n' },
  // --- embeds / transclusion ---
  { name: 'embed-image', tier: 1, src: '![[diagram.png]]\n' },
  { name: 'embed-image-size', tier: 1, src: '![[diagram.png|200]]\n' },
  { name: 'embed-note', tier: 1, src: '![[Other Note]]\n' },
  { name: 'embed-note-heading', tier: 1, src: '![[Other Note#Section]]\n' },
  { name: 'embed-note-blockref', tier: 1, src: '![[Other Note#^abc123]]\n' },
  // --- callouts ---
  { name: 'callout-simple', tier: 1, src: '> [!note]\n> A note body.\n' },
  { name: 'callout-title', tier: 1, src: '> [!warning] Custom Title\n> Body line.\n' },
  { name: 'callout-foldable', tier: 1, src: '> [!tip]- Collapsed\n> Hidden body.\n' },
  { name: 'callout-nested', tier: 1, src: '> [!note] Outer\n> > [!info] Inner\n> > inner body\n' },
  // --- math ---
  { name: 'math-inline', tier: 1, src: 'Energy is $E = mc^2$ today.\n' },
  { name: 'math-block', tier: 1, src: '$$\n\\int_0^\\infty x\\,dx\n$$\n' },
  { name: 'dollar-ambiguity', tier: 1, src: 'It costs $5 and $10 in cash.\n' },
  // --- mermaid / code ---
  { name: 'mermaid', tier: 1, src: '```mermaid\ngraph TD\nA --> B\n```\n' },
  { name: 'code-hash', tier: 1, src: '```bash\ngrep "#FF0000" file.txt # a hex color\n```\n' },
  // --- tables ---
  { name: 'table', tier: 1, src: '| A | B |\n| - | - |\n| 1 | 2 |\n' },
  // --- frontmatter ---
  { name: 'frontmatter', tier: 1, src: '---\ntitle: Hello\ntags: [a, b]\n---\n\nBody.\n' },
  // --- tags / mixed ---
  { name: 'inline-tag', tier: 2, src: 'A #security/tag inline.\n' },
];
