import { fail } from './errors.js';

// Owner-chosen private binding is transport-neutral: any encrypted overlay
// (WireGuard-style tailnets use RFC 6598 space), VPN, or trusted LAN presents
// as one numeric IPv4 address. Nothing here may reference a vendor network.
export const PRIVATE_NETWORK_IPV4_RANGES = Object.freeze([
  Object.freeze({ cidr: '127.0.0.0/8', label: 'loopback' }),
  Object.freeze({ cidr: '10.0.0.0/8', label: 'RFC 1918 private' }),
  Object.freeze({ cidr: '172.16.0.0/12', label: 'RFC 1918 private' }),
  Object.freeze({ cidr: '192.168.0.0/16', label: 'RFC 1918 private' }),
  Object.freeze({ cidr: '100.64.0.0/10', label: 'RFC 6598 shared address space' }),
]);

const RANGE_BOUNDS = PRIVATE_NETWORK_IPV4_RANGES.map(({ cidr }) => {
  const [base, prefix] = cidr.split('/');
  const baseValue = base
    .split('.')
    .reduce((total, octet) => total * 256 + Number(octet), 0);
  const size = 2 ** (32 - Number(prefix));
  return { low: baseValue, high: baseValue + size - 1 };
});

function ipv4Value(value) {
  // Canonical dotted decimal only: no shorthand, hex, octal, integer forms,
  // leading zeros, whitespace, CIDR suffixes, hostnames, or IPv6.
  if (typeof value !== 'string' || !/^(?:(?:0|[1-9][0-9]{0,2})\.){3}(?:0|[1-9][0-9]{0,2})$/u.test(value)) {
    return null;
  }
  let total = 0;
  for (const octet of value.split('.')) {
    const numeric = Number(octet);
    if (numeric > 255) return null;
    total = total * 256 + numeric;
  }
  return total;
}

export function validatePrivateNetworkIpv4Host(value, location = 'host') {
  const numeric = ipv4Value(value);
  if (numeric !== null) {
    for (const { low, high } of RANGE_BOUNDS) {
      // The exact range endpoints are never a usable host address. Whether an
      // interior address is a subnet network/broadcast address depends on a
      // netmask this config does not know; exact OS binding rejects those.
      if (numeric > low && numeric < high) return value;
    }
  }
  fail(
    'private-network-host-required',
    `${location} must be one exact private numeric IPv4 address (loopback, RFC 1918, or RFC 6598 shared address space)`,
    { location, allowedRanges: PRIVATE_NETWORK_IPV4_RANGES.map((range) => range.cidr) },
  );
}

export function validatePrivateNetworkHttpOrigin(value, location = 'ownerOrigin') {
  const reject = () => fail(
    'private-network-origin-required',
    `${location} must be one exact http origin on a private numeric IPv4 address with an explicit non-default port`,
    { location },
  );

  if (typeof value !== 'string' || value.length === 0) reject();
  let url;
  try {
    url = new URL(value);
  } catch {
    reject();
  }
  if (url.protocol !== 'http:'
    || url.username !== ''
    || url.password !== ''
    || url.port === ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
    || url.origin !== value) {
    reject();
  }
  try {
    validatePrivateNetworkIpv4Host(url.hostname, `${location} host`);
  } catch {
    reject();
  }
  return value;
}
