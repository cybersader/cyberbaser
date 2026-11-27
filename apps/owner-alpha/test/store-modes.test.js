import { expect, test } from 'bun:test';
import { storeModes } from '../src/store-modes.js';

const ROOT = '/opt/cyberbaser/.workspace/owner-alpha/store';

test('owner-only unless the installed setup turns on group sharing', () => {
  expect(storeModes(`${ROOT}/jobs/OA-1/state.json`, ROOT, {})).toEqual({ directory: 0o700, file: 0o600 });
  expect(storeModes(`${ROOT}/jobs/OA-1/state.json`, ROOT, { CYBERBASER_SHARED_STORE: 'yes' })).toEqual({ directory: 0o700, file: 0o600 });
});

test('with group sharing only job records are shared and the root is only traversable', () => {
  const shared = { CYBERBASER_SHARED_STORE: 'group' };
  expect(storeModes(ROOT, ROOT, shared)).toEqual({ directory: 0o710, file: 0o600 });
  expect(storeModes(`${ROOT}/jobs`, ROOT, shared)).toEqual({ directory: 0o770, file: 0o640 });
  expect(storeModes(`${ROOT}/jobs/OA-1/effects/pushed.json`, ROOT, shared)).toEqual({ directory: 0o770, file: 0o640 });
  for (const other of [`${ROOT}/proposal-decisions/decisions`, `${ROOT}/jobsx/a`, `${ROOT}/sessions/a.json`, '/elsewhere/jobs/a']) {
    expect(storeModes(other, ROOT, shared)).toEqual({ directory: 0o700, file: 0o600 });
  }
  expect(storeModes(undefined, ROOT, shared)).toEqual({ directory: 0o700, file: 0o600 });
});
