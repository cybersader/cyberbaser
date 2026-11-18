import { describe, expect, test } from 'bun:test';
import {
  artifactJson,
  assertNoCredentialMaterial,
  canonicalJson,
  deepFreeze,
  isPlainObject,
} from '../src/json.js';

// All values here are clearly synthetic fixtures, never captured credentials.
// Keep the legacy matcher restricted to short inputs, including on assertion failure.
const LEGACY_CREDENTIAL_VALUE = /(?:[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@|\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{12,}\b|\bgithub_pat_[A-Za-z0-9_]{12,}\b|\bsk-[A-Za-z0-9_-]{16,}\b)/i;
const PARITY_MAX_CHARACTERS = 160;

function rejectsCredential(value) {
  try {
    assertNoCredentialMaterial(value);
    return false;
  } catch (error) {
    if (error.code !== 'credentials-forbidden') throw error;
    return true;
  }
}

function expectCredential(value, rejected) {
  // Compare booleans only: failures must not dump even synthetic full values.
  expect(rejectsCredential(value)).toBe(rejected);
}

function expectLegacyParity(value) {
  if (value.length > PARITY_MAX_CHARACTERS) throw new Error('synthetic parity input exceeds its small-only bound');
  expectCredential(value, LEGACY_CREDENTIAL_VALUE.test(value));
}

function expectErrorCode(action, code) {
  let observed = null;
  try {
    action();
  } catch (error) {
    observed = error.code;
  }
  expect(observed).toBe(code);
}

describe('JSON serialization and credential boundaries', () => {
  test('recognizes only plain objects, including null-prototype objects', () => {
    for (const value of [{}, Object.create(null)]) expect(isPlainObject(value)).toBe(true);
    for (const value of [null, [], 'synthetic', 3, new Date(0), new Map(), Object.create({ inherited: true })]) {
      expect(isPlainObject(value)).toBe(false);
    }
  });

  test('canonical serialization keeps recursive sorted keys and array order', () => {
    const nullPrototype = Object.assign(Object.create(null), { z: 2, a: 1 });
    const value = { z: [nullPrototype, 3, false, null], a: { z: 'synthetic', a: 1 } };
    expect(canonicalJson(value)).toBe('{"a":{"a":1,"z":"synthetic"},"z":[{"a":1,"z":2},3,false,null]}');
    expect(Object.keys(value)).toEqual(['z', 'a']);
    expect(Object.keys(nullPrototype)).toEqual(['z', 'a']);
  });

  test('canonical serialization preserves JSON string escaping and numeric behavior', () => {
    for (const value of [null, true, false, 0, -0, 1.25, 'synthetic\r\n\t"\\/\u0000é😀\ud800']) {
      expect(canonicalJson(value) === JSON.stringify(value)).toBe(true);
    }
    // canonicalJson itself intentionally does not perform the artifact credential check.
    expect(canonicalJson({ password: 'synthetic' })).toBe('{"password":"synthetic"}');
  });

  test('rejects non-JSON values without changing the canonical error code', () => {
    for (const value of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('synthetic'), () => {}, new Date(0), new Map()]) {
      expectErrorCode(() => canonicalJson(value), 'invalid-json-value');
    }
    expectErrorCode(() => canonicalJson({ nested: undefined }), 'invalid-json-value');
  });

  test('artifacts retain exact text values and append exactly one serialization newline', () => {
    const text = '# Synthetic source\r\n\né😀\u0000\t"\\\ud800';
    const value = { z: ['synthetic', { text }], a: 1 };
    const before = JSON.stringify(value);
    const artifact = artifactJson(value);
    expect(artifact === `${canonicalJson(value)}\n`).toBe(true);
    expect(JSON.parse(artifact).z[1].text === text).toBe(true);
    expect(JSON.stringify(value) === before).toBe(true);
  });

  test('deepFreeze still freezes only nested arrays and plain objects', () => {
    const leaf = Object.assign(Object.create(null), { text: 'synthetic' });
    const date = new Date(0);
    const value = { list: [leaf, date] };
    expect(deepFreeze(value) === value).toBe(true);
    for (const entry of [value, value.list, leaf]) expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(date)).toBe(false);
  });

  test('credential keys retain normalized case-insensitive suffix rejection at every depth', () => {
    for (const key of [
      'password', 'passwd', 'secret', 'token', 'credential', 'authorization', 'cookie',
      'privatekey', 'clientsecret', 'apikey', 'accesstoken', 'refreshtoken',
      'API-Key', 'ACCESS_token', 'prefix.client-secret', 'syntheticRefreshToken',
    ]) {
      expectCredential({ outer: [{ [key]: 'synthetic' }] }, true);
    }
    const nullPrototype = Object.assign(Object.create(null), { 'PRIVATE-KEY': 'synthetic' });
    expectCredential(nullPrototype, true);
  });

  test('benign key near-misses and non-plain objects keep their previous behavior', () => {
    expectCredential({ passwords: 'synthetic', tokenized: 'synthetic', secrets: 'synthetic', text: 'synthetic' }, false);
    expectCredential(new Map([['password', 'synthetic']]), false);
    expectCredential(Object.create({ password: 'synthetic' }), false);
  });

  test('artifact credential failures retain nested locations without echoing values', () => {
    const value = 'https://synthetic-user:synthetic-pass@fixture.invalid/';
    let observed;
    try {
      artifactJson({ nested: [{ text: value }] });
    } catch (error) {
      observed = error;
    }
    expect(observed?.code).toBe('credentials-forbidden');
    expect(observed?.message).toBe('credential-like material is forbidden at $.nested[0].text');
    expect(observed?.message.includes(value)).toBe(false);
    expectErrorCode(() => artifactJson({ nested: [{ 'api-key': 'synthetic' }] }), 'credentials-forbidden');
  });
});

describe('synthetic credential values', () => {
  test('all original token families retain minimum lengths and case insensitivity', () => {
    for (const kind of ['p', 'o', 'u', 's', 'r']) {
      const prefix = ['gh', kind, '_'].join('');
      expectCredential(`${prefix}${'SYNTHETIC'.repeat(2)}`, true);
      expectCredential(`${prefix.toUpperCase()}${'x'.repeat(12)}`, true);
      expectCredential(`${prefix}${'x'.repeat(11)}`, false);
    }
    const githubPrefix = ['github', 'pat', ''].join('_');
    const skPrefix = ['sk', ''].join('-');
    expectCredential(`${githubPrefix}${'SYNTHETIC'.repeat(2)}`, true);
    expectCredential(`${githubPrefix.toUpperCase()}${'x'.repeat(12)}`, true);
    expectCredential(`${githubPrefix}${'x'.repeat(11)}`, false);
    expectCredential(`${skPrefix}${'SYNTHETIC'.repeat(2)}`, true);
    expectCredential(`${skPrefix.toUpperCase()}${'x'.repeat(16)}`, true);
    expectCredential(`${skPrefix}${'x'.repeat(15)}`, false);
  });

  test('token word boundaries, allowed characters and nested value traversal are unchanged', () => {
    const prefix = ['gh', 'p', '_'].join('');
    const token = `${prefix}${'x'.repeat(12)}`;
    expectCredential(`(${token})`, true);
    expectCredential(`é${token}`, true);
    expectCredential(`a${token}`, false);
    expectCredential(`_${token}`, false);
    expectCredential(`${prefix}${'x'.repeat(6)}-${'x'.repeat(6)}`, false);
    expectCredential({ outer: [0, false, { text: token }] }, true);
    expectCredential(`${['sk', ''].join('-')}${'x_-'.repeat(6)}`, true);
  });

  test('URL credentials keep arbitrary ASCII schemes and unanchored suffix matches', () => {
    for (const scheme of ['https', 'HtTpS', 'GIT+SSH', 'a', 'a0+.-', '123a', '9+.-a9', 'éa', '_a', 'aéb']) {
      expectCredential(`${scheme}://synthetic-user:synthetic-pass@fixture.invalid`, true);
    }
    expectCredential('prose!a://synthetic-user:synthetic-pass@fixture.invalid/end', true);
    expectCredential('a://synthetic-user:synthetic-pass@', true);
  });

  test('schemes do not acquire Unicode case folding or cross non-ASCII boundaries', () => {
    for (const scheme of ['', '123+.-', 'é', 'aé', 'K', 'ſ', 'aK', 'aſ']) {
      expectCredential(`${scheme}://synthetic-user:synthetic-pass@fixture.invalid`, false);
    }
    for (const scheme of ['éA', 'KA', 'ſa', 'aé9B']) {
      expectCredential(`${scheme}://synthetic-user:synthetic-pass@fixture.invalid`, true);
    }
  });

  test('scheme runs with more than 31 trailing nonletters still reject', () => {
    for (const suffix of ['9'.repeat(96), '+.-0123456789'.repeat(16)]) {
      expectCredential(`a${suffix}://synthetic-user:synthetic-pass@fixture.invalid`, true);
      expectCredential(`éA${suffix}://synthetic-user:synthetic-pass@fixture.invalid`, true);
      expectCredential(`${suffix}://synthetic-user:synthetic-pass@fixture.invalid`, false);
    }
  });

  test('userinfo allows colons on either side but requires one strictly interior colon', () => {
    for (const userinfo of ['synthetic-user:synthetic-pass', 'a:b', ':::', 'a::', '::b', ':a:b', 'a:b:', 'a:b:c', ':a::b:']) {
      expectCredential(`a://${userinfo}@fixture.invalid`, true);
    }
    for (const userinfo of ['', 'synthetic', ':', '::', ':a', 'a:', ':a:']) {
      expectCredential(`a://${userinfo}@fixture.invalid`, false);
    }
  });

  test('first slash or at-sign terminates userinfo, without interpreting URL syntax', () => {
    for (const value of [
      'https://fixture.invalid/a:b@later.invalid',
      'a://synthetic@a:b@fixture.invalid',
      'a://synthetic-user:/synthetic-pass@fixture.invalid',
      'a://:synthetic-pass@fixture.invalid',
      'a://synthetic-user:@fixture.invalid',
      'a://synthetic-user:synthetic-pass',
      'a:/synthetic-user:synthetic-pass@fixture.invalid',
      'a:///synthetic-user:synthetic-pass@fixture.invalid',
    ]) expectCredential(value, false);
    // The original matcher is deliberately not a URL parser.
    for (const userinfo of ['?a:b', '#a:b', 'a%40:b', 'a\\b:c', 'é:😀']) {
      expectCredential(`a://${userinfo}@fixture.invalid`, true);
    }
  });

  test('userinfo retains exactly the original JavaScript whitespace classification', () => {
    const whitespace = [
      '\u0009', '\u000a', '\u000b', '\u000c', '\u000d', '\u0020', '\u00a0', '\u1680',
      '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007',
      '\u2008', '\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff',
    ];
    for (const character of whitespace) {
      for (const userinfo of [`${character}a:b`, `a:${character}b`, `a:b${character}`]) {
        expectCredential(`a://${userinfo}@fixture.invalid`, false);
      }
    }
    for (const character of ['\u0085', '\u180e', '\u200b', '\u0000', '\ud800']) {
      expectCredential(`a://a${character}:b@fixture.invalid`, true);
    }
  });

  test('later delimiters are still considered after malformed earlier candidates', () => {
    for (const prefix of ['a://', 'a://a:b/', 'a://@', '123://', 'a://a:', 'a://:a@/']) {
      expectCredential(`${prefix}B://synthetic-user:synthetic-pass@fixture.invalid`, true);
    }
    expectCredential('a://b://c://synthetic-user:synthetic-pass@fixture.invalid', true);
    expectCredential('a://b://c://synthetic', false);
  });
});

describe('bounded small-only legacy parity', () => {
  test('matches the old regex on 30800 structured short cases', () => {
    const schemes = ['', 'a', 'A', '1', '+.-', '1a', 'a1+.-', 'é', 'aé', 'éa', 'K', 'ſ', 'aK', 'Ka', 'a9'.padEnd(48, '9'), 'a+'.padEnd(48, '+')];
    const userinfos = [
      '', 'a', ':', '::', ':::', ':a', 'a:', 'a:b', ':a:', 'a::', '::b', 'a:b:c',
      'a/b:c', 'a:b/c', 'a@b:c', 'a:b@c', 'a b:c', 'a:b\n', 'é:😀', 'a\u00a0:b',
      'a\u0085:b', 'a\u200b:b', 'a\\:b', '?a:b', 'a::b:',
    ];
    const prefixes = ['', '!', '_', '9', 'a://bad@/', 'a://b://', 'é'];
    const endings = ['@', '@fixture.invalid', '/', ' ', '', '@a://a:b@fixture.invalid', '\n@', '@@', '@/a:b@', '://a:b@', '\u200b@'];
    let count = 0;
    for (const scheme of schemes) {
      for (const userinfo of userinfos) {
        for (const prefix of prefixes) {
          for (const ending of endings) {
            expectLegacyParity(`${prefix}${scheme}://${userinfo}${ending}`);
            count += 1;
          }
        }
      }
    }
    expect(count).toBe(30800);
  });

  test('matches the old regex on 6000 deterministic short mixed cases', () => {
    const alphabet = ['a', 'Z', '0', '+', '.', '-', ':', '/', '@', ' ', '\n', '\u00a0', '\u0085', 'é', 'K', 'ſ', '_', '\\', '\u200b'];
    let state = 0x51a7c0de;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    for (let iteration = 0; iteration < 6000; iteration += 1) {
      let value = '';
      const length = next() % 64;
      for (let index = 0; index < length; index += 1) value += alphabet[next() % alphabet.length];
      if (iteration % 2 === 0) value += '://a:b@fixture.invalid';
      if (iteration % 3 === 0) value = `a://${value}`;
      expectLegacyParity(value);
    }
  });

  test('the parity helper refuses any large legacy-regex input before scanning', () => {
    let refused = false;
    try {
      expectLegacyParity('a'.repeat(PARITY_MAX_CHARACTERS + 1));
    } catch (error) {
      refused = error.message === 'synthetic parity input exceeds its small-only bound';
    }
    expect(refused).toBe(true);
  });
});

describe('large synthetic inputs use only the repaired scanner', () => {
  test('400000 and 710000 allowed-character runs serialize unchanged', () => {
    for (const text of ['a'.repeat(400000), 'b'.repeat(400000), 'c'.repeat(710000)]) {
      const value = { text };
      expectCredential(value, false);
      const result = artifactJson(value);
      expect(result === `{"text":${JSON.stringify(text)}}\n`).toBe(true);
      expect(value.text === text).toBe(true);
    }
  });

  test('long benign hex, base64 and minified source remain allowed and exact', () => {
    const values = [
      '0123456789abcdef'.repeat(32768),
      'U1lOVEhFVElDX0ZJWFRVUkU+'.repeat(20000),
      'U1lOVEhFVElD/'.repeat(40000),
      '{"synthetic":[0,1],"text":"benign"};'.repeat(16000),
    ];
    for (const text of values) {
      expect(text.length >= 400000).toBe(true);
      expectCredential(text, false);
      expect(JSON.parse(artifactJson({ text })).text === text).toBe(true);
    }
  });

  test('400000-character nonletter scheme tails keep their original rejection', () => {
    const tail = '09+.-'.repeat(80000);
    expectCredential(`a${tail}://synthetic-user:synthetic-pass@fixture.invalid`, true);
    expectCredential(`éA${tail}://synthetic-user:synthetic-pass@fixture.invalid`, true);
    expectCredential(`${tail}://synthetic-user:synthetic-pass@fixture.invalid`, false);
    expectCredential(`aé${tail}://synthetic-user:synthetic-pass@fixture.invalid`, false);
  });

  test('long userinfo and colon-rich spans stay bounded with and without a terminal at-sign', () => {
    const left = 'a'.repeat(400000);
    const right = 'b'.repeat(400000);
    expectCredential(`a://${left}:${right}@fixture.invalid`, true);
    expectCredential(`a://${left}:${right}/@fixture.invalid`, false);
    const colons = ':'.repeat(450000);
    expectCredential(`a://${colons}@fixture.invalid`, true);
    expectCredential(`a://${colons}/@fixture.invalid`, false);
    expectCredential(`a://${colons}`, false);
    expectCredential(`a://${left}:@fixture.invalid`, false);
  });

  test('100001 repeated delimiters cannot introduce overlapping long scans', () => {
    const repeated = 'a://'.repeat(100001);
    expect(repeated.length > 400000).toBe(true);
    expectCredential(repeated, false);
    expectCredential(`${repeated}synthetic-user:synthetic-pass@fixture.invalid`, true);
    expectCredential(`${'0://'.repeat(100001)}synthetic-user:synthetic-pass@fixture.invalid`, false);
    expectCredential(`${'a::::://'.repeat(60000)}synthetic-user:synthetic-pass@fixture.invalid`, false);
  });
});
