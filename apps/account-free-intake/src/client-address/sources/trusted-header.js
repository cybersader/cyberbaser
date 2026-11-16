import { exactObject, fail } from '../../control-config.js';
import { parseCidr, parseIp } from '../ip.js';

export const trustedHeader = Object.freeze({
  id: 'trusted-header',
  validateOptions(input) {
    exactObject(input, ['header', 'trustedPeers'], 'clientAddress');
    // One lowercase HTTP field-name token, never a list or a header value.
    if (typeof input.header !== 'string' || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(input.header)) {
      fail('invalid-config', 'clientAddress.header must be one lowercase HTTP header token');
    }
    if (!Array.isArray(input.trustedPeers) || input.trustedPeers.length < 1 || input.trustedPeers.length > 100
      || input.trustedPeers.some((cidr) => parseCidr(cidr) === null)
      || new Set(input.trustedPeers).size !== input.trustedPeers.length) {
      fail('invalid-config', 'clientAddress.trustedPeers must contain unique IPv4 or IPv6 CIDRs');
    }
    return Object.freeze({ header: input.header, trustedPeers: Object.freeze([...input.trustedPeers]) });
  },
  create(options) {
    const trusted = options.trustedPeers.map(parseCidr);
    return (request, peer) => {
      const socket = parseIp(peer?.address);
      if (socket !== null && trusted.some((cidr) => (
        cidr.family === socket.family ? socket.numeric >> cidr.shift === cidr.network
          : cidr.family === 6 && socket.family === 4 && ((65535n << 32n) | socket.numeric) >> cidr.shift === cidr.network
      ))) {
        const forwarded = parseIp(request.headers.get(options.header));
        if (forwarded !== null) return forwarded.address;
      }
      return socket?.address ?? null;
    };
  },
});
