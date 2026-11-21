import { describe, expect, test } from 'bun:test';
import { comparePublicationEffects } from '../src/effects.js';

function publication(...entries) {
  return { published: entries.map(([source]) => source), addresses: new Map(entries) };
}

const page = ['pub/page.md', 'pub/page.md'];
const other = ['pub/other.md', 'pub/other.md'];
const unchangedSet = { changed: false, added: [], removed: [] };
const unchangedAddresses = { ...unchangedSet, moved: [] };

describe('publication effects', () => {
  test('identical publication results have no effects', () => {
    expect(comparePublicationEffects(publication(page), publication(page))).toEqual({
      publicSet: unchangedSet,
      addresses: unchangedAddresses,
    });
  });

  test('reports notes gaining and losing selection', () => {
    const gained = comparePublicationEffects(publication(page), publication(page, other));
    expect(gained).toEqual({
      publicSet: { changed: true, added: [other[0]], removed: [] },
      addresses: { changed: true, added: [other[0]], removed: [], moved: [] },
    });
    const lost = comparePublicationEffects(publication(page, other), publication(page));
    expect(lost).toEqual({
      publicSet: { changed: true, added: [], removed: [other[0]] },
      addresses: { changed: true, added: [], removed: [other[0]], moved: [] },
    });
  });

  test('counts an asset newly selected through a body reference', () => {
    // Pre-computed selection/projection output; references are the selector's business.
    const image = ['private/image.png', 'private/image.png'];
    const effects = comparePublicationEffects(publication(page), publication(page, image));
    expect(effects).toEqual({
      publicSet: { changed: true, added: [image[0]], removed: [] },
      addresses: { changed: true, added: [image[0]], removed: [], moved: [] },
    });
  });

  test('reports a note moving while selection stays the same', () => {
    const effects = comparePublicationEffects(publication(page, other), publication([page[0], 'new.md'], other));
    expect(effects).toEqual({
      publicSet: unchangedSet,
      addresses: { changed: true, added: [], removed: [], moved: [{ source: page[0], from: page[1], to: 'new.md' }] },
    });
  });

  test('reports both sources moving when addresses are swapped', () => {
    const effects = comparePublicationEffects(publication(page, other), publication([page[0], other[1]], [other[0], page[1]]));
    expect(effects).toEqual({
      publicSet: unchangedSet,
      addresses: {
        changed: true, added: [], removed: [], moved: [
          { source: other[0], from: other[1], to: page[1] },
          { source: page[0], from: page[1], to: other[1] },
        ],
      },
    });
  });

  test('reports source removal and addition when a new note takes a vacated address', () => {
    const replacement = ['replacement.md', page[1]];
    const effects = comparePublicationEffects(publication(page, other), publication(other, replacement));
    expect(effects).toEqual({
      publicSet: { changed: true, added: [replacement[0]], removed: [page[0]] },
      addresses: { changed: true, added: [replacement[0]], removed: [page[0]], moved: [] },
    });
    const moved = comparePublicationEffects(publication(page), publication([page[0], 'new.md'], replacement));
    expect(moved.addresses).toEqual({
      changed: true, added: [replacement[0]], removed: [], moved: [{ source: page[0], from: page[1], to: 'new.md' }],
    });
  });

  test('input ordering does not affect equality or the order of changes', () => {
    const before = [page, other, ['z.md', 'z.md'], ['b.md', 'b.md']];
    const after = [[other[0], 'other-new.md'], [page[0], 'page-new.md'], ['y.md', 'y.md'], ['a.md', 'a.md']];
    expect(comparePublicationEffects(publication(...before), publication(...before.toReversed()))).toEqual({
      publicSet: unchangedSet,
      addresses: unchangedAddresses,
    });
    const effects = comparePublicationEffects(publication(...before), publication(...after));
    expect(effects).toEqual(comparePublicationEffects(publication(...before.toReversed()), publication(...after.toReversed())));
    expect(effects.publicSet.added).toEqual(['a.md', 'y.md']);
    expect(effects.publicSet.removed).toEqual(['b.md', 'z.md']);
  });
});
