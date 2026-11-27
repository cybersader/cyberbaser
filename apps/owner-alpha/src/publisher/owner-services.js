// Starts what signed publish adds to a publisher: its owner-key list, the
// approval gate before every push, the owner control socket, and (when asked)
// the loopback page that shows the first-device code.
//
// owners: { directory, mode = 'enforce', enrollPort = null, authorizedUids = [] }
//   directory   publisher-owned state (a start argument, never node config)
//   mode        'enforce' or 'report' (rollout only)
//   enrollPort  loopback port for the first-device page, or null
//   authorizedUids  the only local UIDs that can read that page
import { createApprovalGate } from './approval-gate.js';
import { startEnrollPage, startOwnerControl } from './owner-control.js';
import { createOwnerKeys } from './owner-keys.js';

export async function startOwnerServices({ owners, socketPath, uid, socketGroup = null, mirror = null, starterCheckout = null,
  log = (line) => process.stdout.write(`${line}\n`), now = Date.now }) {
  const ownerKeys = await createOwnerKeys({ directory: owners.directory, uid, log, now });
  const gate = createApprovalGate({ ownerKeys, mode: owners.mode ?? 'enforce', log, now });
  const publishStarter = mirror === null || starterCheckout === null ? null
    : ({ commit, record }) => mirror.publishStarter({ checkout: starterCheckout, commit,
      authorize: (target) => gate.authorize(record, target) });
  // Page bundles go through the mirror like the starter, always signed.
  const publishBundle = mirror === null || starterCheckout === null || typeof mirror.publishBundle !== 'function' ? null
    : ({ commit, record }) => mirror.publishBundle({ checkout: starterCheckout, commit,
      authorize: (target) => gate.authorize(record, target) });
  const opened = [];
  try {
    opened.push(await startOwnerControl({ socketPath, ownerKeys, uid, socketGroup, publishStarter, publishBundle }));
    // Only the independent administrative handoff or authorized loopback page
    // may display enrollment material. Never put it in service logs.
    if (await ownerKeys.ensureEnrollment() !== null) {
      log('No device can publish yet. A setup code is open; "cyberbaser publisher enroll-code" (as administrator) shows a new one.');
    }
    if (owners.enrollPort !== null && owners.enrollPort !== undefined) {
      opened.push(await startEnrollPage({ ownerKeys, port: owners.enrollPort, authorizedUids: owners.authorizedUids }));
    }
  } catch (error) {
    for (const item of opened.reverse()) await item.close().catch(() => {});
    throw error;
  }
  return Object.freeze({
    ownerKeys,
    gate,
    async close() { for (const item of opened.reverse()) await item.close().catch(() => {}); },
  });
}
