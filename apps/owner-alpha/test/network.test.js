import { describe, expect, test } from 'bun:test';
import { OwnerAlphaError } from '../src/errors.js';
import {
  PRIVATE_NETWORK_IPV4_RANGES,
  validatePrivateNetworkIpv4Host,
  validatePrivateNetworkHttpOrigin,
} from '../src/network.js';

function expectCode(action, code) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(OwnerAlphaError);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected OwnerAlphaError(${code})`);
}

describe('private network IPv4 host validation', () => {
  const accepted = [
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '10.255.255.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.0.1',
    '192.168.255.254',
    '100.64.0.1',
    '100.127.255.254',
    '100.100.100.100',
  ];

  const rejected = [
    // hostnames and IPv6
    'localhost',
    'LOCALHOST',
    'wiki.internal',
    '::1',
    '[::1]',
    'fe80::1',
    // wildcard, endpoints of every allowlisted range
    '0.0.0.0',
    '127.0.0.0',
    '127.255.255.255',
    '10.0.0.0',
    '10.255.255.255',
    '172.16.0.0',
    '172.31.255.255',
    '192.168.0.0',
    '192.168.255.255',
    '100.64.0.0',
    '100.127.255.255',
    // adjacent to allowlisted ranges
    '100.63.255.255',
    '100.128.0.0',
    '172.15.255.255',
    '172.32.0.0',
    '192.167.255.255',
    '192.169.0.0',
    // public, link-local, multicast, broadcast
    '8.8.8.8',
    '203.0.113.7',
    '169.254.1.1',
    '224.0.0.1',
    '255.255.255.255',
    // non-canonical numeric forms
    '127.1',
    '2130706433',
    '0x7f000001',
    '010.0.0.1',
    '10.00.0.1',
    '127.0.0.1.',
    '.127.0.0.1',
    ' 127.0.0.1',
    '127.0.0.1 ',
    '10.0.0.1/8',
    '10.0.0.256',
    '',
  ];

  test('accepts interior addresses of every allowlisted private range', () => {
    for (const host of accepted) {
      expect(validatePrivateNetworkIpv4Host(host)).toBe(host);
    }
  });

  test('rejects hostnames, wildcard, endpoints, public space, and non-canonical forms', () => {
    for (const host of rejected) {
      expectCode(() => validatePrivateNetworkIpv4Host(host), 'private-network-host-required');
    }
    for (const value of [null, undefined, 4317, {}, ['127.0.0.1']]) {
      expectCode(() => validatePrivateNetworkIpv4Host(value), 'private-network-host-required');
    }
  });

  test('reports the allowlisted ranges and its location in the failure details', () => {
    const error = expectCode(
      () => validatePrivateNetworkIpv4Host('8.8.8.8', '$.listen.host'),
      'private-network-host-required',
    );
    expect(error.details.location).toBe('$.listen.host');
    expect(error.details.allowedRanges).toEqual(PRIVATE_NETWORK_IPV4_RANGES.map((range) => range.cidr));
  });
});

describe('private network HTTP origin validation', () => {
  test('accepts one exact canonical http origin for each private range family', () => {
    for (const origin of [
      'http://127.0.0.1:4317',
      'http://10.1.2.3:4317',
      'http://172.16.5.9:8443',
      'http://192.168.1.50:4317',
      'http://100.100.100.100:4317',
    ]) {
      expect(validatePrivateNetworkHttpOrigin(origin)).toBe(origin);
    }
  });

  test('rejects wrong scheme, hosts, default port, credentials, and non-origin shapes', () => {
    for (const origin of [
      'https://127.0.0.1:4317',
      'http://localhost:4317',
      'http://8.8.8.8:4317',
      'http://[::1]:4317',
      'http://127.0.0.1',
      'http://127.0.0.1:80',
      'http://user@127.0.0.1:4317',
      'http://user:pw@127.0.0.1:4317',
      'http://127.0.0.1:4317/',
      'http://127.0.0.1:4317/owner',
      'http://127.0.0.1:4317?x=1',
      'http://127.0.0.1:4317#x',
      'HTTP://127.0.0.1:4317',
      'not a url',
      '',
    ]) {
      expectCode(() => validatePrivateNetworkHttpOrigin(origin), 'private-network-origin-required');
    }
  });
});
