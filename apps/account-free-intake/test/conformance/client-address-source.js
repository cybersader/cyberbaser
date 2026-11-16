import { describe, expect, test } from 'bun:test';
import { parseIp } from '../../src/client-address.js';

// Harness: { options, invalidOptions[], cases: [{ headers, peer, address }] }.
// A source returns one numeric IP string or null, not a header list or identity.
export function clientAddressSourceConformance(source, harness) {
  describe(`${source.id} client-address source conformance`, () => {
    test('validates exact options, freezes cloned arrays and rejects invalid config', () => {
      const input = structuredClone(harness.options);
      const options = source.validateOptions(input);
      expect(Object.isFrozen(options)).toBe(true);
      expect(input).toEqual(harness.options);
      expect(Object.isFrozen(input)).toBe(false);
      for (const nested of Object.values(options)) {
        if (nested !== null && typeof nested === 'object') expect(Object.isFrozen(nested)).toBe(true);
      }
      for (const invalid of harness.invalidOptions) {
        try {
          source.validateOptions(invalid);
          throw new Error('unexpected valid source config');
        } catch (error) { expect(error.code).toBe('invalid-config'); }
      }
    });

    test('resolves only numeric identities or null without modifying inputs', () => {
      const resolve = source.create(source.validateOptions(structuredClone(harness.options)));
      expect(typeof resolve).toBe('function');
      for (const entry of harness.cases) {
        const request = new Request('https://intake.example', { headers: entry.headers ?? {} });
        const peer = entry.peer === null ? null : Object.freeze({ address: entry.peer });
        const value = resolve(request, peer);
        expect(value === null || typeof value === 'string').toBe(true);
        expect(parseIp(value)).toEqual(parseIp(entry.address));
        expect(value === null || parseIp(value) !== null).toBe(true);
      }
    });
  });
}
