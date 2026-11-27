// The Iroh WASM build, embedded in main.js (Obsidian loads one script file).
// Loaded only on first use, so opening Obsidian stays light. Browser Iroh can
// only use the relay named in the node's ticket; it opens no other socket.
import init, { Session } from '../carrier/target/browser/carrier.js';
import { WASM_BASE64 } from '../build/wasm-inline.js';
import { fromBase64 } from './core/wire.js';

let ready = null;

export function loadCarrier() {
  ready ??= init({ module_or_path: fromBase64(WASM_BASE64) }).catch((error) => { ready = null; throw error; });
  return ready.then(() => Object.freeze({
    async open(secret, ticket, alpn) {
      const session = await Session.open(secret, ticket, alpn);
      return {
        nodeId: () => session.nodeId(),
        endpointId: () => session.endpointId(),
        exchange: (bytes) => session.exchange(bytes),
        async close() { await session.close(); session.free(); },
      };
    },
  }));
}

// A carrier that loads the WASM on the first connection.
export const lazyCarrier = Object.freeze({
  async open(secret, ticket, alpn) {
    return (await loadCarrier()).open(secret, ticket, alpn);
  },
});
