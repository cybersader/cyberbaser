/** One rendered block becomes one exact, non-empty source selector, never Markdown. */
export interface SuggestedEdit {
  quote: string
  prefix: string
  suffix: string
  replacement: string
}

const word = (character: string | undefined) => character !== undefined && /[\p{L}\p{N}\p{M}_]/u.test(character)
const insideWord = (text: string[], offset: number) => word(text[offset - 1]) && word(text[offset])
const bytes = (text: string) => new TextEncoder().encode(text).length

/** Code points keep surrogate pairs intact. No whitespace or Unicode normalization. */
export function deriveSuggestedEdit(original: string, edited: string): SuggestedEdit | null {
  if (original === edited) return null
  const before = Array.from(original)
  const after = Array.from(edited)
  if (before.length === 0) throw new Error("Choose a block containing text.")
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = before.length
  let newEnd = after.length
  while (end > start && newEnd > start && before[end - 1] === after[newEnd - 1]) {
    end--
    newEnd--
  }

  // Insertions still need a source quote: carry the adjacent word unchanged.
  if (start === end) {
    let anchor = start - 1
    while (anchor >= 0 && !word(before[anchor])) anchor--
    if (anchor >= 0) {
      while (anchor > 0 && word(before[anchor - 1])) anchor--
      start = anchor
    } else {
      let next = end
      while (next < before.length && !word(before[next])) next++
      if (next < before.length) {
        while (next < before.length && word(before[next])) next++
        newEnd += next - end
        end = next
      } else if (start > 0) start-- // A block made only of punctuation/emoji.
      else { end++; newEnd++ }
    }
  }
  while (start > 0 && (insideWord(before, start) || insideWord(after, start))) start--
  while (end < before.length && (insideWord(before, end) || insideWord(after, newEnd))) {
    end++
    newEnd++
  }
  let contextStart = Math.max(0, start - 40)
  let contextEnd = Math.min(before.length, end + 40)
  while (contextStart < start && insideWord(before, contextStart)) contextStart++
  while (contextEnd > end && insideWord(before, contextEnd)) contextEnd--
  const result = {
    quote: before.slice(start, end).join(""),
    prefix: before.slice(contextStart, start).join(""),
    suffix: before.slice(end, contextEnd).join(""),
    replacement: after.slice(start, newEnd).join(""),
  }
  if (bytes(result.quote) > 16 * 1024 || bytes(result.replacement) > 16 * 1024) {
    throw new Error("This edit is too long. Try changing a smaller part of the page.")
  }
  return result
}
