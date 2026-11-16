import { getClientAddressSource } from './client-address/registry.js';
import { parseIp } from './client-address/ip.js';

export { parseIp, parseCidr, networkIdentity } from './client-address/ip.js';
export { validateClientAddress } from './client-address/registry.js';

export function createClientAddressResolver(config = { source: 'socket' }) {
  const { source, ...options } = config;
  const resolve = getClientAddressSource(source).create(options);
  // Core canonicalizes every source result before quota keying or verification.
  return (request, peer) => parseIp(resolve(request, peer));
}
