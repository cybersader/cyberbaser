// Masking core: replace OFM constructs with inert placeholder tokens so a
// CommonMark parser never reinterprets them, then restore after processing.
// Proven in spikes/ofm-roundtrip/ (R05); hardened here per the R12 spec:
// collision-safe Unicode private-use-area sentinels instead of a plain string.

const S0 = ''; // sentinel open (PUA)
const S1 = ''; // sentinel close (PUA)

// Order matters: embeds before wikilinks (![[..]] contains [[..]]),
// comments early so constructs inside %%..%% stay part of the comment.
export const OFM_PATTERNS = [
  { name: 'comment', re: /%%[\s\S]*?%%/g },
  { name: 'embed', re: /!\[\[[^\]]+\]\]/g },
  { name: 'wikilink', re: /\[\[[^\]]+\]\]/g },
  { name: 'callout-marker', re: /\[![A-Za-z][\w-]*\]/g },
];

export class MaskCollisionError extends Error {
  constructor() {
    super('input already contains the PUA sentinel characters U+E000/U+E001; refusing to mask');
    this.name = 'MaskCollisionError';
  }
}

export function mask(src) {
  if (src.includes(S0) || src.includes(S1)) throw new MaskCollisionError();
  const store = [];
  let out = src;
  for (const { re } of OFM_PATTERNS) {
    out = out.replace(re, (m) => {
      const token = `${S0}${store.length}${S1}`;
      store.push(m);
      return token;
    });
  }
  return { text: out, store };
}

export function unmask(text, store) {
  return text.replace(new RegExp(`${S0}(\\d+)${S1}`, 'g'), (whole, i) => store[+i] ?? whole);
}

/** True if any sentinel survived unmasking — a processing step ate a token. */
export function hasMaskLeak(text) {
  return text.includes(S0) || text.includes(S1);
}
