/**
 * Path safety lint + slug contract.
 *
 * Canonical design: docs/src/content/docs/research/proposal-renderer-urls.md, D2 (slug
 * contract) and D3 (safety lint, not a style lint).
 *
 * The vault is the source of truth and is never modified here. This module only reads
 * path strings and reports.
 */

/** Windows-illegal characters, excluding the separator itself. */
const ILLEGAL_CHARS = ['<', '>', ':', '"', '|', '?', '*']
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/

/** Windows reserved device names. Reserved with or without an extension. */
const RESERVED_NAMES = new Set(
  ['CON', 'PRN', 'AUX', 'NUL']
    .concat(Array.from({ length: 9 }, (_, i) => `COM${i + 1}`))
    .concat(Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)),
)

const MAX_PATH_LENGTH = 200

/** Pictographic codepoints. Deliberately excludes digits and `#`, which are Emoji but not pictographic. */
const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}/gu

export const RULES = {
  1: 'illegal-chars',
  2: 'reserved-name',
  3: 'edge-whitespace-or-dot',
  4: 'path-too-long',
  5: 'not-nfc',
  6: 'slug-collision',
}

/** Strip leading `./` and `/`, and any trailing `/`. */
function stripSlashes(p) {
  return p.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
}

function stripMarkdownExtension(p) {
  return p.replace(/\.md$/i, '')
}

/**
 * The slug contract from D2, per path segment, in order:
 *   whitespace -> "-", "&" -> "-and-", "%" -> "-percent", "?" and "#" removed,
 *   ".md" ext removed, trailing "/" removed, then lowercased.
 *
 * The first six steps are Quartz's `sluggify()` verbatim (quartz/util/path.ts) so a
 * Quartz spoke needs zero custom code. The lowercase step is ours (D3: GitHub Pages
 * serves from Linux, so case-varying paths are distinct URLs).
 *
 * Input is normalized to NFC first so the same logical name in NFD and NFC produces one
 * slug. Rule 5 still reports the NFD path itself as a violation.
 */
export function sluggify(vaultPath) {
  const normalized = stripSlashes(String(vaultPath).normalize('NFC'))
  return stripMarkdownExtension(normalized)
    .split('/')
    .map((segment) =>
      segment
        .replace(/\s/g, '-')
        .replace(/&/g, '-and-')
        .replace(/%/g, '-percent')
        .replace(/\?/g, '')
        .replace(/#/g, ''),
    )
    .join('/')
    .replace(/\/$/, '')
    .toLowerCase()
}

/**
 * The key collisions are grouped by. Deliberately stricter than the slug itself: it also
 * collapses runs of `-` and trims them at segment edges, so near-collisions collide too
 * (`A & B` slugs to `a--and--b`, `A and B` to `a-and-b`; D2 calls that pair out as a
 * collision). Every exact slug collision is also a key collision, so stricter here means
 * no false negatives on the one rule that catches silent data loss.
 */
export function slugKey(vaultPath) {
  return sluggify(vaultPath)
    .split('/')
    .map((segment) => segment.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, ''))
    .join('/')
}

function violation(rule, path, extra = {}) {
  return { rule, code: RULES[rule], path, ...extra }
}

/**
 * The five per-path safety rules from D3. Rule 6 (slug collisions) is cross-path and
 * lives in `lintVault`.
 *
 * Explicitly not violations: spaces, `&`, `%`, mixed case, non-Latin scripts, emoji.
 */
export function lintPath(path) {
  const raw = String(path)
  const violations = []
  const segments = stripSlashes(raw).split('/').filter((s) => s.length > 0)

  for (const segment of segments) {
    const found = ILLEGAL_CHARS.filter((c) => segment.includes(c))
    const hasControl = CONTROL_CHARS.test(segment)
    if (found.length > 0 || hasControl) {
      violations.push(
        violation(1, raw, {
          segment,
          chars: found,
          control: hasControl,
          message: `illegal character(s) ${[...found, ...(hasControl ? ['<control>'] : [])].join(' ')} in segment "${segment}"`,
        }),
      )
    }

    const stem = segment.split('.')[0].toUpperCase()
    if (RESERVED_NAMES.has(stem)) {
      violations.push(
        violation(2, raw, {
          segment,
          reserved: stem,
          message: `reserved Windows device name "${stem}" in segment "${segment}"`,
        }),
      )
    }

    if (segment !== segment.trim() || segment.endsWith('.')) {
      violations.push(
        violation(3, raw, {
          segment,
          message: `segment "${segment}" has leading/trailing whitespace or a trailing dot`,
        }),
      )
    }
  }

  if (raw.length > MAX_PATH_LENGTH) {
    violations.push(
      violation(4, raw, {
        length: raw.length,
        message: `path is ${raw.length} characters, over the ${MAX_PATH_LENGTH} limit`,
      }),
    )
  }

  if (raw.normalize('NFC') !== raw) {
    violations.push(
      violation(5, raw, {
        nfc: raw.normalize('NFC'),
        message: 'path is not in Unicode NFC form',
      }),
    )
  }

  return violations
}

function countPictographic(s) {
  const matches = s.match(PICTOGRAPHIC)
  return matches ? matches.length : 0
}

/**
 * Emoji census. Report-only in v1: renames are a maintainer decision, so nothing here
 * becomes a violation. Split by directory segment vs basename because D3 treats those
 * differently (directory emoji percent-encode into unreadable URL segments; basename
 * emoji are rarer and renamed inside Obsidian).
 */
function emojiCensusOf(paths) {
  const directorySegments = new Map()
  const basenameFiles = []
  const pathsWithEmoji = new Set()
  let directoryPaths = 0
  let directoryCodepoints = 0
  let basenameCodepoints = 0

  for (const path of paths) {
    const segments = stripSlashes(String(path)).split('/').filter((s) => s.length > 0)
    if (segments.length === 0) continue
    const basename = segments[segments.length - 1]
    const dirs = segments.slice(0, -1)

    let pathDirCodepoints = 0
    for (const segment of dirs) {
      const n = countPictographic(segment)
      if (n === 0) continue
      pathDirCodepoints += n
      const entry = directorySegments.get(segment) || { segment, paths: 0, codepoints: 0 }
      entry.paths += 1
      entry.codepoints += n
      directorySegments.set(segment, entry)
    }
    if (pathDirCodepoints > 0) {
      directoryPaths += 1
      directoryCodepoints += pathDirCodepoints
      pathsWithEmoji.add(path)
    }

    const baseCodepoints = countPictographic(basename)
    if (baseCodepoints > 0) {
      basenameCodepoints += baseCodepoints
      basenameFiles.push({ path, codepoints: baseCodepoints })
      pathsWithEmoji.add(path)
    }
  }

  return {
    pathsWithEmoji: pathsWithEmoji.size,
    directory: {
      paths: directoryPaths,
      codepoints: directoryCodepoints,
      segments: [...directorySegments.values()].sort((a, b) => b.paths - a.paths),
    },
    basename: {
      paths: basenameFiles.length,
      codepoints: basenameCodepoints,
      files: basenameFiles,
    },
  }
}

/**
 * Lint a whole vault: per-path rules 1-5, plus rule 6 (slug collisions) across the set,
 * plus the report-only emoji census.
 *
 * Returns `{ violations, collisions, emojiCensus }`. A collision group is
 * `{ key, slugs, paths, exact }`; `exact` is true when every path in the group produces
 * a byte-identical slug (as opposed to colliding only on the stricter key).
 */
export function lintVault(paths) {
  const list = [...paths].map(String)
  const violations = []

  for (const path of list) violations.push(...lintPath(path))

  const byKey = new Map()
  for (const path of list) {
    const key = slugKey(path)
    const group = byKey.get(key) || { key, paths: [], slugs: [] }
    group.paths.push(path)
    const slug = sluggify(path)
    if (!group.slugs.includes(slug)) group.slugs.push(slug)
    byKey.set(key, group)
  }

  const collisions = [...byKey.values()]
    .filter((g) => g.paths.length > 1)
    .map((g) => ({ ...g, exact: g.slugs.length === 1 }))
    .sort((a, b) => b.paths.length - a.paths.length || a.key.localeCompare(b.key))

  for (const group of collisions) {
    for (const path of group.paths) {
      violations.push(
        violation(6, path, {
          key: group.key,
          slug: sluggify(path),
          collidesWith: group.paths.filter((p) => p !== path),
          message: `slug collision on "${group.key}" with ${group.paths.length - 1} other path(s)`,
        }),
      )
    }
  }

  return { violations, collisions, emojiCensus: emojiCensusOf(list) }
}
