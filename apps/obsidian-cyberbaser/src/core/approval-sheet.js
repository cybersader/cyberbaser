// The approval sheet for new pages, drawn from a prepared approval's summary
// (signing.js), which this device built from the exact bytes it signs.
//
// Only element creation with text is used here (Obsidian's createEl / createDiv
// / createSpan with { text }), so a title or summary like "<img onerror=…>" is
// shown as those characters and never read as markup. Photos are drawn from
// their signed bytes through imageUrl(bytes, mediaType) (a blob: URL in the
// plugin); nothing in a note can choose where an image comes from.

/** "Publish to Cyberchief", or "Publish to your site" when the site has no name here. */
export function approvalHeading(summary) {
  return summary.site ? `Publish to ${summary.site}` : 'Publish to your site';
}

/** True when the sheet shows pages (a bundle with at least one new page). */
export function showsPages(summary) {
  return Array.isArray(summary.pages) && summary.pages.length > 0;
}

/**
 * Draw the page cards, other photos and the folded exact text into container.
 * imageUrl(bytes, mediaType) -> URL string for an <img>.
 */
export function renderPages(container, summary, { imageUrl }) {
  const list = container.createDiv({ cls: 'cyberbaser-pages' });
  for (const page of summary.pages) {
    const card = list.createDiv({ cls: 'cyberbaser-page-card' });
    if (page.cover) {
      card.createEl('img', { cls: 'cyberbaser-page-cover', attr: { src: imageUrl(page.cover.bytes, page.cover.mediaType), alt: 'Cover photo' } });
    }
    const body = card.createDiv({ cls: 'cyberbaser-page-body' });
    body.createDiv({ cls: 'cyberbaser-page-title', text: page.title });
    body.createDiv({ cls: 'cyberbaser-page-address', text: page.address });
    if (page.description) body.createDiv({ cls: 'cyberbaser-page-summary', text: page.description });
    const exact = card.createEl('details', { cls: 'cyberbaser-exact' });
    exact.createEl('summary', { text: 'Show exact text' });
    exact.createEl('pre', { cls: 'cyberbaser-exact-text', text: page.text });
  }
  if (summary.photos?.length) {
    const strip = container.createDiv({ cls: 'cyberbaser-photos' });
    for (const photo of summary.photos) {
      strip.createEl('img', { cls: 'cyberbaser-photo', attr: { src: imageUrl(photo.bytes, photo.mediaType), alt: 'Photo' } });
    }
  }
  return list;
}
