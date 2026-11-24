import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { addressFor, fileSlug, pageSlug, publicAddress, readAddressStyle, tagSlug } from '../src/index.js';

const LH = 'lowercase-hyphen';
// From the Cyberchief renderer repository (site/address-rule.cases.json), copied as is.
const CYBERCHIEF = JSON.parse(readFileSync(new URL('./fixtures/cyberchief-address-rule.cases.json', import.meta.url), 'utf8'));

test('lowercase-hyphen matches every Cyberchief renderer case (paths and tags)', () => {
  expect(CYBERCHIEF.cases.length + CYBERCHIEF.tags.length).toBe(34);
  for (const { path, slug, address } of CYBERCHIEF.cases) {
    expect([path, fileSlug(path, LH)]).toEqual([path, slug]);
    if (/\.md$/iu.test(path)) expect([path, addressFor(path, null, LH)]).toEqual([path, `/${address}`]);
  }
  for (const { tag, slug } of CYBERCHIEF.tags) expect([tag, tagSlug(tag, LH)]).toEqual([tag, slug]);
});

test('lowercase-hyphen: more readable names', () => {
  expect(addressFor('Threats & response/Run a tabletop exercise in one hour.md', null, LH)).toBe('/threats-and-response/run-a-tabletop-exercise-in-one-hour');
  expect(addressFor('Risk & governance/index.md', null, LH)).toBe('/risk-and-governance/');
  expect(addressFor('index.md', null, LH)).toBe('/');
  expect(addressFor('A/_index.md', null, LH)).toBe('/a/');
  // A segment with no letters or digits has no address.
  expect(addressFor('Topic/!!!.md', null, LH)).toBeNull();
  expect(pageSlug('../x.md', LH)).toBeNull();
  // An explicit slug: moves the page, by the same rule.
  expect(addressFor('Topic/Long title.md', 'Short Name', LH)).toBe('/short-name');
  expect(addressFor('Topic/Long title.md', 'index', LH)).toBe('/');
});

test('quartz (the default): stock Quartz 4.5.2, case kept, & as -and-', () => {
  expect(addressFor('Leadership & strategy/Questions to ask a new CISO.md')).toBe('/Leadership--and--strategy/Questions-to-ask-a-new-CISO');
  expect(addressFor('topic/sub/index.md')).toBe('/topic/sub/');
  expect(addressFor('a/100% sure?.md')).toBe('/a/100-percent-sure');
  expect(addressFor('a/_index.md')).toBe('/a/');
  expect(fileSlug('Topic/Cover Photo.JPG')).toBe('Topic/Cover-Photo.JPG');
  expect(addressFor('a\\b.md')).toBeNull();
  // publicAddress is the same function with the style passed through.
  expect(publicAddress('Leadership & strategy/Questions to ask a new CISO.md', null, LH)).toBe('/leadership-and-strategy/questions-to-ask-a-new-ciso');
  expect(publicAddress('/topic/a b.md')).toBe('/topic/a-b');
  expect(() => pageSlug('a.md', 'kebab')).toThrow();
});

test('site.yml: addresses under site: or at the top; unknown or conflicting values fail closed', () => {
  expect(readAddressStyle(null)).toEqual({ ok: true, style: 'quartz' });
  expect(readAddressStyle('site:\n  title: X\n')).toEqual({ ok: true, style: 'quartz' });
  expect(readAddressStyle('site:\n  title: X\n  addresses: lowercase-hyphen\n')).toEqual({ ok: true, style: LH });
  expect(readAddressStyle('addresses: lowercase-hyphen\n')).toEqual({ ok: true, style: LH });
  expect(readAddressStyle('addresses: quartz\nsite:\n  addresses: quartz\n')).toEqual({ ok: true, style: 'quartz' });
  expect(readAddressStyle('addresses: quartz\nsite:\n  addresses: lowercase-hyphen\n').ok).toBe(false);
  expect(readAddressStyle('site:\n  addresses: kebab\n').ok).toBe(false);
  expect(readAddressStyle('addresses: [\n').ok).toBe(false);
  // Cyberchief's own file.
  expect(readAddressStyle('site:\n  title: Cyberchief\n  addresses: lowercase-hyphen\nappearance:\n  colorScheme: dark\n'))
    .toEqual({ ok: true, style: LH });
});
