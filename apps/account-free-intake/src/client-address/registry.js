import { isRecord, fail } from '../control-config.js';
import { socket } from './sources/socket.js';
import { trustedHeader } from './sources/trusted-header.js';

export const clientAddressSources = Object.freeze({ socket, 'trusted-header': trustedHeader });

export function getClientAddressSource(id) {
  // Retain the original wire configuration spelling without coupling to a vendor.
  const canonical = id === 'header' ? 'trusted-header' : id;
  if (typeof canonical !== 'string' || !Object.hasOwn(clientAddressSources, canonical)) {
    fail('invalid-config', 'clientAddress.source must name a registered address source');
  }
  return clientAddressSources[canonical];
}

export function validateClientAddress(input = { source: 'socket' }) {
  if (!isRecord(input)) fail('invalid-config', 'clientAddress must be an object');
  const { source, ...options } = input;
  return Object.freeze({ source, ...getClientAddressSource(source).validateOptions(options) });
}
