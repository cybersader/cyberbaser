import { validateFixture } from './contract.js';
import { adversarialFixtures } from './scenarios/adversarial.js';
import { authorityFixtures } from './scenarios/authority.js';
import { blockedFixtures } from './scenarios/blocked.js';
import { conceptualFixtures } from './scenarios/conceptual.js';
import { executableV1Fixtures } from './scenarios/executable-v1.js';
import { targetV2Fixtures } from './scenarios/target-v2.js';

export const primaryFixtures = Object.freeze([
  ...executableV1Fixtures, ...targetV2Fixtures, ...conceptualFixtures,
  ...blockedFixtures, ...authorityFixtures,
].map(validateFixture));
export const negativeAdversarialFixtures = Object.freeze(adversarialFixtures.map(validateFixture));
export const allFixtures = Object.freeze([...primaryFixtures, ...negativeAdversarialFixtures]);

if (primaryFixtures.length !== 21) throw new Error(`primary fixture matrix must contain exactly 21 fixtures, found ${primaryFixtures.length}`);
const ids = new Set();
for (const fixture of allFixtures) {
  if (ids.has(fixture.fixtureId)) throw new Error(`duplicate fixture ID ${fixture.fixtureId}`);
  ids.add(fixture.fixtureId);
}
const index = new Map(allFixtures.map((fixture) => [fixture.fixtureId, fixture]));

function countBy(key) {
  return Object.freeze(allFixtures.reduce((counts, fixture) => {
    counts[fixture[key]] = (counts[fixture[key]] ?? 0) + 1;
    return counts;
  }, {}));
}

export const corpusReport = Object.freeze({
  evidenceBoundary: 'synthetic-mechanical and static-design-only',
  primaryCount: primaryFixtures.length,
  adversarialCount: negativeAdversarialFixtures.length,
  totalCount: allFixtures.length,
  bySupportLevel: countBy('supportLevel'),
  byEvidenceClass: countBy('evidenceClass'),
  prohibitedClaims: Object.freeze(['maintainer-comprehension', 'independent-human', 'live-effect']),
});

export function fixtureById(fixtureId) {
  return index.get(fixtureId) ?? null;
}
export function listFixtures({ includeAdversarial = true } = {}) {
  return includeAdversarial ? allFixtures : primaryFixtures;
}
