import { expect, test } from 'bun:test';
import { clientAddressSources, getClientAddressSource, validateClientAddress } from '../src/client-address/registry.js';
import { createClientAddressResolver } from '../src/client-address.js';
import { socket } from '../src/client-address/sources/socket.js';
import { trustedHeader } from '../src/client-address/sources/trusted-header.js';
import { clientAddressSourceConformance } from './conformance/client-address-source.js';

clientAddressSourceConformance(socket, {
  options: {}, invalidOptions: [null, { header: 'x-real-ip' }],
  cases: [
    { headers: { 'x-real-ip': '198.51.100.1' }, peer: '192.0.2.1', address: '192.0.2.1' },
    { peer: '::ffff:192.0.2.1', address: '192.0.2.1' },
    { peer: '2001:db8::1', address: '2001:db8::1' },
    { peer: null, address: null }, { peer: 'not-an-ip', address: null },
  ],
});
clientAddressSourceConformance(trustedHeader, {
  options: { header: 'x-real-ip', trustedPeers: ['10.0.0.0/8'] },
  invalidOptions: [null, {}, { header: 'X-Real-IP', trustedPeers: ['10.0.0.0/8'] }],
  cases: [
    { headers: { 'x-real-ip': '198.51.100.1' }, peer: '10.0.0.1', address: '198.51.100.1' },
    { headers: { 'x-real-ip': '198.51.100.1' }, peer: '192.0.2.1', address: '192.0.2.1' },
    { headers: { 'x-real-ip': '198.51.100.1, 203.0.113.2' }, peer: '10.0.0.1', address: '10.0.0.1' },
    { peer: '10.0.0.1', address: '10.0.0.1' },
    { headers: { 'x-real-ip': '198.51.100.1' }, peer: null, address: null },
  ],
});

test('address source registry preserves header alias and rejects inherited ids', () => {
  expect(Object.isFrozen(clientAddressSources)).toBe(true);
  expect(getClientAddressSource('header')).toBe(trustedHeader);
  for (const [id, source] of Object.entries(clientAddressSources)) {
    expect(source.id).toBe(id);
    expect(Object.isFrozen(source)).toBe(true);
  }
  for (const id of ['constructor', '__proto__', 'unknown']) {
    expect(() => getClientAddressSource(id)).toThrow(/registered address source/);
  }
});

test('any single lowercase HTTP header token is configurable but never bypasses peer trust', () => {
  for (const header of ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for', 'custom_ip', 'x!#$%&\'*+-.^_`|~9']) {
    for (const source of ['header', 'trusted-header']) {
      const config = validateClientAddress({ source, header, trustedPeers: ['10.0.0.0/8'] });
      expect(config.source).toBe(source);
      const resolve = createClientAddressResolver(config);
      const request = new Request('https://intake.example', { headers: { [header]: '198.51.100.1' } });
      expect(resolve(request, { address: '10.1.1.1' }).address).toBe('198.51.100.1');
      expect(resolve(request, { address: '192.0.2.1' }).address).toBe('192.0.2.1');
    }
  }
});

test('header names cannot be empty, uppercase, whitespace, lists or non-tokens', () => {
  for (const header of ['', 'X-Real-IP', 'x real ip', 'x-real-ip,other', 'x-real-ip:80', 'x/real', 'é', null]) {
    expect(() => validateClientAddress({ source: 'header', header, trustedPeers: ['10.0.0.0/8'] })).toThrow(/lowercase HTTP header token/);
  }
});
