import { validatePrivateNetworkIpv4Host } from '../network.js';

export const REACH_USAGE = 'direct|relay-only|private-address:<ip>';

/** Carrier-neutral ingress policy. The provider owns the translation to sockets
 * and must not silently broaden the policy if it cannot bind as requested. */
export function resolveReach(selection = 'direct') {
  if (selection === 'direct') return { mode: 'direct', ipv4: null };
  if (selection === 'relay-only') return { mode: 'relay-only', ipv4: '127.0.0.1' };
  if (typeof selection === 'string' && selection.startsWith('private-address:')) {
    const ipv4 = validatePrivateNetworkIpv4Host(selection.slice('private-address:'.length), 'private-address');
    return { mode: 'private-address', ipv4 };
  }
  throw new Error(`Reach must be ${REACH_USAGE} (RFC 1918, CGNAT or loopback IPv4 only).`);
}
