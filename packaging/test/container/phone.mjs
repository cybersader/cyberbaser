// The owner's phone in the container setup test: the Obsidian plugin's own
// pairing, enrolment and approval code (apps/obsidian-cyberbaser/src/core),
// headless. Only two things differ from the plugin in Obsidian: the Iroh
// carrier is the node's native bindings instead of the WASM build, and a
// "tap" is a test token instead of a trusted click. Keys are WebCrypto,
// non-extractable, and live only in this process (as in IndexedDB).
//
//   BUN_BE_BUN=1 cyberbaser phone.mjs <port>
// Serves POST http://127.0.0.1:<port>/<command> with a JSON body; every reply
// is one JSON object. Synthetic data only.
import { connectToNode } from '/src/apps/owner-alpha/src/iroh-carrier.js';
import { createNodeClient } from '/src/apps/obsidian-cyberbaser/src/core/client.js';
import { createController } from '/src/apps/obsidian-cyberbaser/src/core/controller.js';
import { createDeviceStore, memoryBackend } from '/src/apps/obsidian-cyberbaser/src/core/device-store.js';
import { approvalFor, createSigningStore, intentDigest } from '/src/apps/obsidian-cyberbaser/src/core/signing.js';
import { createTapGate } from '/src/apps/obsidian-cyberbaser/src/core/tap.js';
import { notePublicStatus } from '/src/apps/obsidian-cyberbaser/src/core/new-page.js';

const port = Number(process.argv[2]);
const taps = new WeakSet();
const tap = () => { const value = { tap: true }; taps.add(value); return value; };

const carrier = {
  async open(secret, ticket, alpn) {
    const session = await connectToNode({ secretKey: Buffer.from(secret), ticket, alpn });
    return {
      nodeId: () => session.nodeId,
      endpointId: () => session.clientEndpointId,
      async exchange(bytes) {
        const stream = await session.connection.openBi();
        await stream.send.writeAll([...bytes]);
        await stream.send.finish();
        return new Uint8Array(await stream.recv.readToEnd(512 * 1024));
      },
      async close() { try { session.connection.close(0n, []); } catch { /* closed */ } await session.endpoint.close(); },
    };
  },
};
const signingBackend = memoryBackend();
const controller = createController({ client: createNodeClient({ carrier }), store: createDeviceStore(memoryBackend(), 'vault:phone'),
  signingStore: createSigningStore(signingBackend, 'vault:phone'), tapGate: createTapGate((event) => taps.has(event)) });

let pairing = null; // { words, done, error }
const approved = []; // every { intent, approval } this phone sent, for the replay check

const reason = (error) => error?.reason ?? error?.kind ?? error?.code ?? String(error?.message ?? error);
const commands = {
  // Starts pairing with the node's code; returns the four words once the node
  // answers. The pairing finishes when the owner confirms on the node's page.
  async pair({ code }) {
    pairing = { words: null, done: false, error: null };
    let shown;
    const words = new Promise((resolve) => { shown = resolve; });
    controller.pair(code, { onWords: (list) => { pairing.words = list; shown(list); } })
      .then(() => { pairing.done = true; }, (error) => { pairing.error = reason(error); shown(null); });
    const list = await words;
    return list === null ? { ok: false, code: pairing.error } : { ok: true, words: list };
  },
  async paired() {
    for (let i = 0; i < 120 && !pairing?.done && !pairing?.error; i++) await Bun.sleep(500);
    return pairing?.done ? { ok: true, ...(await controller.paired()) } : { ok: false, code: pairing?.error ?? 'not-paired' };
  },
  async enrol({ link }) {
    return { ok: true, ...(await controller.enrol(link, { label: 'Synthetic phone', tap: tap() })) };
  },
  async enrolNoTap({ link }) { return { ok: true, ...(await controller.enrol(link, { label: 'Synthetic phone' })) }; },
  async device() { return { ok: true, device: await controller.signingDevice() }; },
  // Waits for a request to show up, checks it as the plugin does, and approves
  // it when it changes exactly the expected paths.
  async approve({ paths, approve = true }) {
    let found = null;
    for (let i = 0; i < 120 && found === null; i++) {
      for (const entry of await controller.waitingApprovals()) {
        const prepared = await controller.readApproval(entry.requestId);
        if (prepared.summary.files.map((file) => file.path).join(',') === paths.join(',')) { found = prepared; break; }
      }
      if (found === null) await Bun.sleep(1000);
    }
    if (found === null) return { ok: false, code: 'nothing-waiting' };
    const summary = { repository: found.summary.repository, branch: found.summary.branch, message: found.summary.message,
      files: found.summary.files.map((file) => ({ path: file.path, kind: file.kind, preview: file.preview })) };
    if (!approve) { await controller.decline(found.requestId); return { ok: true, declined: true, summary }; }
    const key = await createSigningStore(signingBackend, 'vault:phone').load();
    const record = { intent: found.template, approval: await approvalFor(key.privateKey, await intentDigest(found.template)) };
    await controller.approve(found, tap());
    approved.push(record);
    return { ok: true, summary, commit: found.template.commit?.id ?? null };
  },
  // The owner tapped Approve on a request that showed this exact intent: the
  // device signs exactly what it was shown (used for the wrong-commit and
  // revoked-device checks, where the node then misuses the signature).
  async signIntent({ intent }) {
    const key = await createSigningStore(signingBackend, 'vault:phone').load();
    if (key === null) return { ok: false, code: 'not-enrolled' };
    const template = { ...intent, keyId: key.keyId };
    return { ok: true, record: { intent: template, approval: await approvalFor(key.privateKey, await intentDigest(template)) } };
  },
  // The New post form's Publish, as the plugin sends it: the note text (and
  // one cover image, already cleaned) as a page bundle. publishYml and siteYml
  // are the vault's own files, which the plugin reads from the vault.
  async newPost({ path, text, publishYml, siteYml, image = null }) {
    const images = [];
    if (image !== null) {
      const bytes = new Uint8Array(await Bun.file(image.file).arrayBuffer());
      images.push({ path: image.path, bytes, size: bytes.length, refused: null });
    }
    const status = notePublicStatus({ path, text, publishYml, siteYml });
    const outcome = await controller.publishNewPage({ path }, text, { status, images, remote: [] });
    return { ok: true, status, ...outcome };
  },
  // Approve the waiting request that includes this path (a bundle: note and images).
  // publishYml / siteYml: the phone vault's own files, which the plugin reads
  // to work out new public pages itself (without them it refuses).
  async approveIncluding({ path, publishYml = null, siteYml = null }) {
    let found = null;
    for (let i = 0; i < 600 && found === null; i++) {
      for (const entry of await controller.waitingApprovals()) {
        const prepared = await controller.readApproval(entry.requestId, { publishYml, siteYml });
        if (prepared.summary.files.some((file) => file.path === path)) { found = prepared; break; }
      }
      if (found === null) await Bun.sleep(1000);
    }
    if (found === null) return { ok: false, code: 'nothing-waiting' };
    await controller.approve(found, tap());
    return { ok: true, files: found.summary.files.map((file) => ({ path: file.path, kind: file.kind })),
      pages: (found.pages ?? found.summary.pages ?? []).map((page) => ({ title: page.title, address: page.address })),
      commit: found.template.commit?.id ?? null };
  },
  async progress({ bundleId }) { return { ok: true, ...(await controller.bundleProgress(bundleId)) }; },
  async lastApproved() { return approved.length === 0 ? { ok: false } : { ok: true, record: approved.at(-1) }; },
};

Bun.serve({
  hostname: '127.0.0.1', port,
  async fetch(request) {
    const name = new URL(request.url).pathname.slice(1);
    if (request.method !== 'POST' || !Object.hasOwn(commands, name)) return Response.json({ ok: false, code: 'usage' }, { status: 404 });
    try { return Response.json(await commands[name](await request.json().catch(() => ({})))); }
    catch (error) { return Response.json({ ok: false, code: reason(error) }); }
  },
});
process.stdout.write(`phone ready on ${port}\n`);
