import { describe, expect, test } from 'bun:test'
import { lintPath, lintVault, slugKey, sluggify } from '../src/paths.js'

const codesFor = (path) => lintPath(path).map((v) => v.code)
const rulesFor = (path) => lintPath(path).map((v) => v.rule)

describe('sluggify: the slug contract (D2)', () => {
  test('whitespace becomes a dash', () => {
    expect(sluggify('Threat Modeling.md')).toBe('threat-modeling')
    expect(sluggify('a\tb.md')).toBe('a-b')
    expect(sluggify('Notes/Two  Spaces.md')).toBe('notes/two--spaces')
  })

  test('& becomes -and-', () => {
    expect(sluggify('Cats&Dogs.md')).toBe('cats-and-dogs')
    expect(sluggify('A & B.md')).toBe('a--and--b')
  })

  test('% becomes -percent', () => {
    expect(sluggify('100%.md')).toBe('100-percent')
    expect(sluggify('Notes/50% Rule.md')).toBe('notes/50-percent-rule')
  })

  test('? and # are removed', () => {
    expect(sluggify('What Now?.md')).toBe('what-now')
    expect(sluggify('C#.md')).toBe('c')
    expect(sluggify('Is it #1?.md')).toBe('is-it-1')
  })

  test('the .md extension is removed, other extensions are kept', () => {
    expect(sluggify('Note.md')).toBe('note')
    expect(sluggify('Note.MD')).toBe('note')
    expect(sluggify('assets/diagram.png')).toBe('assets/diagram.png')
    expect(sluggify('Folder.md/inner.md')).toBe('folder.md/inner')
  })

  test('leading and trailing slashes are removed', () => {
    expect(sluggify('/Notes/Sub/')).toBe('notes/sub')
    expect(sluggify('./Notes/Note.md')).toBe('notes/note')
  })

  test('the result is lowercased (our extension: Pages serves from Linux)', () => {
    expect(sluggify('Areas/Threat Modeling.md')).toBe('areas/threat-modeling')
    expect(sluggify('ÄRA/Straße.md')).toBe('ära/straße')
  })

  test('directory separators survive; each segment is transformed independently', () => {
    expect(sluggify('R&D/Q1 Plan.md')).toBe('r-and-d/q1-plan')
  })

  test('input is normalized to NFC before slugging', () => {
    const nfd = 'Café/Résumé.md'.normalize('NFD')
    const nfc = 'Café/Résumé.md'.normalize('NFC')
    expect(nfd).not.toBe(nfc)
    expect(sluggify(nfd)).toBe(sluggify(nfc))
    expect(sluggify(nfc)).toBe('café/résumé')
  })

  test('non-Latin basenames pass through, lowercased where case exists', () => {
    expect(sluggify('概念/脅威 モデリング.md')).toBe('概念/脅威-モデリング')
    expect(sluggify('Заметки/Моделирование Угроз.md')).toBe('заметки/моделирование-угроз')
  })

  test('slugKey collapses dash runs so near-collisions group together', () => {
    expect(slugKey('A & B.md')).toBe('a-and-b')
    expect(slugKey('A and B.md')).toBe('a-and-b')
    expect(slugKey('# Heading.md')).toBe('heading')
  })
})

describe('lintPath rule 1: Windows-illegal characters', () => {
  test.each([['<'], ['>'], [':'], ['"'], ['|'], ['?'], ['*']])('flags %s', (char) => {
    const violations = lintPath(`Notes/Bad${char}Name.md`)
    expect(violations.map((v) => v.code)).toContain('illegal-chars')
    expect(violations.find((v) => v.rule === 1).chars).toContain(char)
  })

  test('flags control characters', () => {
    const violations = lintPath(`Notes/Bad${String.fromCharCode(7)}Name.md`)
    expect(violations.find((v) => v.rule === 1).control).toBe(true)
  })

  test('flags illegal characters in directory segments too', () => {
    const violations = lintPath('Bad:Dir/Fine Name.md')
    const v = violations.find((x) => x.rule === 1)
    expect(v.segment).toBe('Bad:Dir')
  })

  test('does not flag the path separator itself', () => {
    expect(codesFor('a/b/c.md')).toEqual([])
  })
})

describe('lintPath rule 2: reserved device basenames', () => {
  test.each([['CON'], ['PRN'], ['AUX'], ['NUL'], ['COM1'], ['COM9'], ['LPT1'], ['LPT9']])(
    'flags %s',
    (name) => {
      expect(codesFor(`Notes/${name}.md`)).toContain('reserved-name')
    },
  )

  test('is case-insensitive and applies with or without an extension', () => {
    expect(codesFor('notes/nul')).toContain('reserved-name')
    expect(codesFor('notes/Com1.txt')).toContain('reserved-name')
  })

  test('flags a reserved directory name', () => {
    const v = lintPath('COM1/note.md').find((x) => x.rule === 2)
    expect(v.reserved).toBe('COM1')
  })

  test('does not flag near-misses', () => {
    expect(codesFor('Notes/COM10.md')).toEqual([])
    expect(codesFor('Notes/CONSOLE.md')).toEqual([])
    expect(codesFor('Notes/COM0.md')).toEqual([])
  })
})

describe('lintPath rule 3: edge whitespace and trailing dot', () => {
  test('flags a trailing space in a segment', () => {
    expect(codesFor('Notes/Trailing.md ')).toContain('edge-whitespace-or-dot')
  })

  test('a space before the extension is not a trailing space', () => {
    expect(codesFor('Notes/Trailing .md')).toEqual([])
  })

  test('flags a leading space in a segment', () => {
    expect(codesFor('Notes/ Leading.md')).toContain('edge-whitespace-or-dot')
  })

  test('flags a trailing space in a directory segment', () => {
    const v = lintPath('Bad Dir /note.md').find((x) => x.rule === 3)
    expect(v.segment).toBe('Bad Dir ')
  })

  test('flags a trailing dot', () => {
    expect(codesFor('Notes/Ends With Dot.')).toContain('edge-whitespace-or-dot')
    expect(codesFor('Notes/dir./note.md')).toContain('edge-whitespace-or-dot')
  })

  test('does not flag interior spaces or dots', () => {
    expect(codesFor('My Notes/Some Note v1.2.md')).toEqual([])
  })
})

describe('lintPath rule 4: total path length', () => {
  test('200 characters is fine, 201 is not', () => {
    const at200 = `${'a'.repeat(197)}.md`
    expect(at200.length).toBe(200)
    expect(codesFor(at200)).toEqual([])

    const at201 = `${'a'.repeat(198)}.md`
    expect(at201.length).toBe(201)
    const v = lintPath(at201).find((x) => x.rule === 4)
    expect(v.length).toBe(201)
  })

  test('length counts the whole path, not the basename', () => {
    const deep = `${Array.from({ length: 10 }, (_, i) => `dir${i}-${'x'.repeat(15)}`).join('/')}/n.md`
    expect(deep.length).toBeGreaterThan(200)
    expect(codesFor(deep)).toContain('path-too-long')
  })
})

describe('lintPath rule 5: Unicode NFC', () => {
  test('flags an NFD path and reports its NFC form', () => {
    const nfd = 'Notes/Résumé.md'.normalize('NFD')
    const v = lintPath(nfd).find((x) => x.rule === 5)
    expect(v.code).toBe('not-nfc')
    expect(v.nfc).toBe('Notes/Résumé.md')
  })

  test('does not flag the NFC form of the same name', () => {
    expect(codesFor('Notes/Résumé.md')).toEqual([])
  })

  test('flags NFD in a directory segment', () => {
    expect(codesFor('Café/note.md'.normalize('NFD'))).toContain('not-nfc')
  })
})

describe('lintPath: explicitly allowed forever (D3)', () => {
  test.each([
    ['spaces', 'Areas/Threat Modeling.md'],
    ['ampersands', 'R&D/Tools & Tactics.md'],
    ['percent signs', 'Notes/100% Coverage.md'],
    ['mixed case', 'Areas/ThreatModeling/README.md'],
    ['CJK basenames', '概念/脅威モデリング.md'],
    ['Cyrillic basenames', 'Заметки/Моделирование.md'],
    ['emoji', '📥 Inbox/idea 💡.md'],
    ['parentheses and commas', 'Notes/Some Note (draft, v2).md'],
  ])('%s produce no violations', (_label, path) => {
    expect(lintPath(path)).toEqual([])
  })

  test('multiple rules can fire on one path', () => {
    expect(rulesFor('Bad:Dir /NUL.md').sort()).toEqual([1, 2, 3])
  })
})

describe('lintVault rule 6: slug collisions', () => {
  test('A & B.md and A and B.md collide', () => {
    const { collisions } = lintVault(['A & B.md', 'A and B.md'])
    expect(collisions.length).toBe(1)
    expect(collisions[0].key).toBe('a-and-b')
    expect(collisions[0].paths.sort()).toEqual(['A & B.md', 'A and B.md'])
    expect(collisions[0].exact).toBe(false)
  })

  test('Threat Modeling.md and Threat-Modeling.md collide exactly', () => {
    const { collisions } = lintVault(['Threat Modeling.md', 'Threat-Modeling.md'])
    expect(collisions.length).toBe(1)
    expect(collisions[0].exact).toBe(true)
    expect(collisions[0].slugs).toEqual(['threat-modeling'])
  })

  test('case-only duplicates collide', () => {
    const { collisions } = lintVault(['Notes/Readme.md', 'Notes/README.md'])
    expect(collisions.length).toBe(1)
    expect(collisions[0].key).toBe('notes/readme')
    expect(collisions[0].exact).toBe(true)
  })

  test('? and # removal creates collisions', () => {
    const { collisions } = lintVault(['What.md', 'What?.md', 'What#.md'])
    expect(collisions.length).toBe(1)
    expect(collisions[0].paths.length).toBe(3)
  })

  test('% handling creates a collision with the spelled-out form', () => {
    const { collisions } = lintVault(['100%.md', '100 percent.md'])
    expect(collisions.length).toBe(1)
    expect(collisions[0].key).toBe('100-percent')
  })

  test('NFD and NFC of the same name collide', () => {
    const { collisions } = lintVault([
      'Résumé.md'.normalize('NFD'),
      'Résumé.md'.normalize('NFC'),
    ])
    expect(collisions.length).toBe(1)
    expect(collisions[0].paths.length).toBe(2)
  })

  test('every path in a colliding group gets a rule 6 violation naming the others', () => {
    const { violations } = lintVault(['Threat Modeling.md', 'Threat-Modeling.md'])
    const sixes = violations.filter((v) => v.rule === 6)
    expect(sixes.length).toBe(2)
    expect(sixes[0].code).toBe('slug-collision')
    expect(sixes[0].collidesWith).toEqual(['Threat-Modeling.md'])
  })

  test('same basename in different folders does not collide', () => {
    const { collisions, violations } = lintVault(['a/Note.md', 'b/Note.md'])
    expect(collisions).toEqual([])
    expect(violations).toEqual([])
  })

  test('a clean vault produces nothing', () => {
    const { violations, collisions, emojiCensus } = lintVault([
      'Areas/Threat Modeling.md',
      'R&D/Tools & Tactics.md',
      '概念/脅威モデリング.md',
      'assets/diagram.png',
    ])
    expect(violations).toEqual([])
    expect(collisions).toEqual([])
    expect(emojiCensus.pathsWithEmoji).toBe(0)
  })
})

describe('lintVault: emoji census (report-only)', () => {
  const paths = [
    '📥 Inbox/note one.md',
    '📥 Inbox/note two.md',
    '📥 Inbox/🔥 hot take.md',
    'Areas/🚀 Launch/plan.md',
    'Areas/plain.md',
    'assets/😀😀 two.png',
  ]

  test('counts directory-segment and basename emoji separately', () => {
    const { emojiCensus } = lintVault(paths)
    expect(emojiCensus.directory.paths).toBe(4)
    expect(emojiCensus.directory.codepoints).toBe(4)
    expect(emojiCensus.basename.paths).toBe(2)
    expect(emojiCensus.basename.codepoints).toBe(3)
    expect(emojiCensus.pathsWithEmoji).toBe(5)
  })

  test('ranks offending directory segments by path count', () => {
    const { emojiCensus } = lintVault(paths)
    expect(emojiCensus.directory.segments[0]).toEqual({
      segment: '📥 Inbox',
      paths: 3,
      codepoints: 3,
    })
  })

  test('emoji never become violations in v1', () => {
    const { violations } = lintVault(paths)
    expect(violations).toEqual([])
  })

  test('digits and # are not counted as emoji', () => {
    const { emojiCensus } = lintVault(['Notes/1 # 2.md'])
    expect(emojiCensus.pathsWithEmoji).toBe(0)
  })
})
