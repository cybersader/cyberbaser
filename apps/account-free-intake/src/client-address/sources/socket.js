import { exactObject } from '../../control-config.js';
import { parseIp } from '../ip.js';

export const socket = Object.freeze({
  id: 'socket',
  validateOptions(input) {
    exactObject(input, [], 'clientAddress');
    return Object.freeze({});
  },
  create() {
    return (_request, peer) => parseIp(peer?.address)?.address ?? null;
  },
});
