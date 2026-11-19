import init, { Client } from '/generated/carrier.js';

await init();
const rpId = 'localhost'; // Test-only secure-context exception; use HTTPS + exact RP ID in deployment.
const text = new TextEncoder();
const encode = value => new Uint8Array(value).toBase64({ alphabet: 'base64url', omitPadding: true });
const decode = value => Uint8Array.fromBase64(value, { alphabet: 'base64url' });

// Test bootstrap supplies only public data to the owner, never exports authenticator secrets.
async function makeEnrollment() {
  const credential = await navigator.credentials.create({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { id: rpId, name: 'Cyberbaser fixture' },
    user: { id: text.encode('fixture-owner'), name: 'fixture-owner', displayName: 'Fixture only' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    attestation: 'none',
    timeout: 5_000,
  } });
  return { origin: location.origin, credentialId: encode(credential.rawId), publicKeySpki: encode(credential.response.getPublicKey()) };
}

async function sign(slot, material, credentialId) {
  const challenge = connections.get(slot).challenge(decode(material.sessionId), decode(material.nonce));
  if (encode(challenge) !== material.challenge) throw new Error('challenge does not match this connection');
  const credential = await navigator.credentials.get({ publicKey: {
    rpId, challenge, userVerification: 'required', timeout: 5_000,
    allowCredentials: [{ type: 'public-key', id: decode(credentialId) }],
  } });
  const { clientDataJSON, authenticatorData, signature } = credential.response;
  return {
    op: 'authenticate', credentialId: encode(credential.rawId), clientDataJson: encode(clientDataJSON),
    authenticatorData: encode(authenticatorData), signature: encode(signature),
  };
}

const connections = new Map();
window.fixture = {
  makeEnrollment, sign,
  async connect(slot, owner, relay) {
    const start = performance.now();
    const client = await Client.connect(owner, relay);
    connections.set(slot, client);
    return { peer: client.endpoint_id(), ms: performance.now() - start };
  },
  async send(slot, frame) {
    const client = connections.get(slot);
    const bytes = text.encode(typeof frame === 'string' ? frame : JSON.stringify(frame));
    const start = performance.now();
    const response = await client.exchange(bytes);
    return { response: JSON.parse(response), ms: performance.now() - start };
  },
  async close(slot) {
    const client = connections.get(slot);
    if (!client) return;
    connections.delete(slot);
    await client.close();
    client.free();
  },
};
