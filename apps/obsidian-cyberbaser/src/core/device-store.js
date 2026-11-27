// Where this device's pairing lives.
//
// Not in the plugin's data.json: that file sits inside the vault
// (.obsidian/plugins/cyberbaser/data.json) and syncs to every other copy of
// the vault, including shared workspace members. The pairing is kept in this
// app's own IndexedDB instead, which never syncs:
//   - the Ed25519 signing key is a non-extractable WebCrypto key, so even code
//     running in this app cannot read its bytes, only ask it to sign;
//   - the Iroh endpoint secret is 32 random bytes (the Iroh WASM build needs
//     them as bytes); it identifies this device to the node and is useless
//     without the signing key.
// One record per vault, so two vaults on one phone pair separately.

const DATABASE = 'cyberbaser-device';
const STORE = 'pairings';
const RECORD_KEYS = ['version', 'keyId', 'audience', 'grants', 'ticket', 'nodeId', 'publicKey', 'privateKey', 'irohSecret', 'pairedAt'];

export function validPairing(record) {
  return record !== null && typeof record === 'object' && RECORD_KEYS.every((key) => Object.hasOwn(record, key))
    && record.version === 1 && typeof record.keyId === 'string' && typeof record.audience === 'string'
    && Array.isArray(record.grants) && typeof record.ticket === 'string' && /^[0-9a-f]{64}$/u.test(record.nodeId)
    && record.irohSecret instanceof Uint8Array && record.irohSecret.length === 32 && record.privateKey !== null;
}

export function createDeviceStore(backend, scope) {
  if (typeof scope !== 'string' || scope.length === 0) throw new TypeError('device store needs a vault scope');
  return Object.freeze({
    async load() {
      const record = await backend.get(scope);
      return validPairing(record) ? record : null;
    },
    async save(record) {
      if (!validPairing(record)) throw new TypeError('invalid pairing record');
      await backend.put(scope, record);
    },
    async clear() {
      await backend.delete(scope);
    },
  });
}

export function memoryBackend() {
  const map = new Map();
  return { map, get: async (key) => map.get(key) ?? null, put: async (key, value) => { map.set(key, value); },
    delete: async (key) => { map.delete(key); } };
}

// The signing key (signing.js) uses its own database through the same backend,
// so pairing and signing never share a record or a schema version.
export function indexedDbBackend(indexedDB = globalThis.indexedDB, { database = DATABASE, store: storeName = STORE } = {}) {
  let opening = null;
  const open = () => (opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opening = null; reject(request.error); };
  }));
  const run = async (mode, action) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const request = action(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result ?? null);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  };
  return {
    get: (key) => run('readonly', (store) => store.get(key)),
    put: (key, value) => run('readwrite', (store) => store.put(value, key)),
    delete: (key) => run('readwrite', (store) => store.delete(key)),
  };
}
