const INVISIBLE_CODE_POINTS = Object.freeze(new Map([
  [0x061c, 'ARABIC LETTER MARK'], [0x200b, 'ZERO WIDTH SPACE'], [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'], [0x200e, 'LEFT-TO-RIGHT MARK'], [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'], [0x202b, 'RIGHT-TO-LEFT EMBEDDING'], [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'], [0x202e, 'RIGHT-TO-LEFT OVERRIDE'], [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'], [0x2068, 'FIRST STRONG ISOLATE'], [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE'],
]));

export function exposeInvisibleText(value) {
  if (typeof value !== 'string') return value;
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    const name = INVISIBLE_CODE_POINTS.get(codePoint);
    return name ? `⟦U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} ${name}⟧` : character;
  }).join('');
}
