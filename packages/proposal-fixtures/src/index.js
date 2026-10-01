import { executableV1Descriptors } from './scenarios/executable-v1.js';
import { buildExecutableV1Fixture } from './executable-v1.js';
import { fixtureById, listFixtures } from './corpus.js';

export { FixtureContractError, fixtureEnums, validateFixture } from './contract.js';
export { ResearchChangeSetError, buildResearchCandidate, validateResearchChangeSet } from './research-change-set.js';
export { allFixtures, corpusReport, fixtureById, listFixtures, negativeAdversarialFixtures, primaryFixtures } from './corpus.js';

const descriptors = new Map(executableV1Descriptors.map((descriptor) => [descriptor.fixtureId, descriptor]));

export function materializeExecutableV1Fixture(fixtureId) {
  const fixture = fixtureById(fixtureId);
  if (fixture === null) throw new RangeError(`unknown fixture ${fixtureId}`);
  if (fixture.supportLevel !== 'executable-v1') throw new TypeError(`fixture ${fixtureId} is ${fixture.supportLevel}; only executable-v1 can be materialized`);
  const descriptor = descriptors.get(fixtureId);
  if (!descriptor) throw new Error(`missing executable descriptor for ${fixtureId}`);
  return buildExecutableV1Fixture(descriptor);
}

export function getFixture(fixtureId) {
  return fixtureById(fixtureId);
}
export function getFixtureList(options) {
  return listFixtures(options);
}
