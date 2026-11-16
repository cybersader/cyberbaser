import { expect, test } from 'bun:test';
import { createClientAddressResolver, networkIdentity, parseCidr, parseIp } from '../src/client-address.js';

const req = (value) => new Request('http://localhost', { headers: value === null ? {} : { 'cf-connecting-ip': value } });
const header = { source: 'header', header: 'cf-connecting-ip', trustedPeers: ['10.0.0.0/8', '2001:db8:abcd::/48'] };

test('socket addressing ignores all client headers by default', () => {
  expect(createClientAddressResolver()(req('198.51.100.1'), { address: '192.0.2.2' }).address).toBe('192.0.2.2');
  expect(createClientAddressResolver()(req('198.51.100.1'), null)).toBeNull();
});

test('client header is authoritative only inside the exact trusted CIDRs', () => {
  const resolve = createClientAddressResolver(header);
  expect(resolve(req('198.51.100.1'), { address: '10.2.3.4' }).address).toBe('198.51.100.1');
  expect(resolve(req('198.51.100.1'), { address: '::ffff:10.2.3.4' }).address).toBe('198.51.100.1');
  expect(resolve(req('198.51.100.1'), { address: '2001:db8:abcd:42::1' }).address).toBe('198.51.100.1');
  expect(resolve(req('198.51.100.1'), { address: '11.2.3.4' }).address).toBe('11.2.3.4');
  expect(resolve(req('198.51.100.1'), { address: '2001:db8:abce::1' })).toEqual(parseIp('2001:db8:abce::1'));
  expect(resolve(req('198.51.100.1'), null)).toBeNull();
});

test.each([null, '', '198.51.100.1, 198.51.100.2', '198.51.100.1:80', '[2001:db8::1]', '::1%eth0', 'example.com', '010.1.2.3', '999.0.0.1'])('malformed or missing client header falls back to socket', (value) => {
  expect(createClientAddressResolver(header)(req(value), { address: '10.2.3.4' }).address).toBe('10.2.3.4');
});

test('normalizes IPv6 and mapped IPv4 identities and groups /24 and /64 networks', () => {
  expect(parseIp('2001:DB8::1')).toEqual(parseIp('2001:0db8:0:0:0:0:0:0001'));
  expect(parseIp('::ffff:192.0.2.1')).toEqual(parseIp('::ffff:c000:201'));
  expect(parseIp('::ffff:c000:201')).toEqual(parseIp('192.0.2.1'));
  expect(networkIdentity(parseIp('192.0.2.1'))).toBe(networkIdentity(parseIp('192.0.2.255')));
  expect(networkIdentity(parseIp('192.0.2.1'))).not.toBe(networkIdentity(parseIp('192.0.3.1')));
  expect(networkIdentity(parseIp('2001:db8:1:2::1'))).toBe(networkIdentity(parseIp('2001:db8:1:2:ffff::1')));
  expect(networkIdentity(parseIp('2001:db8:1:2::1'))).not.toBe(networkIdentity(parseIp('2001:db8:1:3::1')));
});

test.each(['10.0.0.0', '10.0.0.0/-1', '10.0.0.0/33', '2001:db8::/129', '10.0.0.0/08', 'garbage/24', '::ffff:10.0.0.0/129'])('rejects malformed CIDR %s', (value) => {
  expect(parseCidr(value)).toBeNull();
});


test('IPv4-mapped trusted CIDRs match canonical mapped peers without trusting adjacent networks', () => {
  const resolve = createClientAddressResolver({ source: 'header', header: 'cf-connecting-ip', trustedPeers: ['::ffff:10.0.0.0/104'] });
  expect(resolve(req('198.51.100.1'), { address: '::ffff:10.2.3.4' }).address).toBe('198.51.100.1');
  expect(resolve(req('198.51.100.1'), { address: '10.2.3.4' }).address).toBe('198.51.100.1');
  expect(resolve(req('198.51.100.1'), { address: '::ffff:11.2.3.4' }).address).toBe('11.2.3.4');
});
