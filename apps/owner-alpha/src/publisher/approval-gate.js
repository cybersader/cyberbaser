// The check the publisher runs before every push: an owner approval admitted
// against its own key list (owner-keys.js), then the imported commit compared
// with the signed intent field by field, from Git objects alone.
//
// mode 'enforce': any problem refuses the push with a plain reason.
// mode 'report':  the same checks run and are logged; the push goes ahead.
//                 Only for rollout and tests; the installed publisher enforces.
import { checkCommit, receiptBody } from '../../../../packages/signed-intent/src/index.js';
import { OwnerAlphaError } from '../errors.js';
import { APPROVAL_PROBLEMS } from './owner-keys.js';

export const APPROVAL_MODES = Object.freeze(['report', 'enforce']);

export function createApprovalGate({ ownerKeys, mode = 'enforce', log = () => {}, now = Date.now }) {
  if (!APPROVAL_MODES.includes(mode) || ownerKeys === null || typeof ownerKeys?.admitPublish !== 'function') {
    throw new TypeError('approval gate needs owner keys and a mode');
  }
  const report = (what, code) => log(`signed publish (report only): ${what}: ${code}`);

  /**
   * record: the job's owner-approval artifact as the node stored it (or null).
   * Returns { verifyCommit(git, commit), receipt(pushed) }.
   */
  async function authorize(record, { remote, branch }) {
    let admitted = null;
    try {
      admitted = await ownerKeys.admitPublish(record, { remote, branch });
    } catch (error) {
      if (mode === 'enforce' || !(error instanceof OwnerAlphaError)) throw error;
      report('approval', `${error.code} (${error.details?.reason ?? 'unknown'})`);
    }
    return Object.freeze({
      admitted,
      async verifyCommit(git, commit) {
        if (admitted === null) return;
        const result = await checkCommit(git, admitted.intent, commit);
        if (result.ok) return;
        if (mode === 'report') { report('commit', result.code); return; }
        throw new OwnerAlphaError('owner-approval-mismatch', APPROVAL_PROBLEMS['owner-approval-mismatch'], { reason: result.code });
      },
      receipt(pushed) {
        if (admitted === null) return null;
        const body = receiptBody({ intentDigest: admitted.digest, keyId: admitted.keyId, provider: admitted.provider,
          commit: pushed.commit, remote, branch, remoteHeadBefore: pushed.status === 'pushed' ? admitted.intent.base : pushed.commit,
          remoteHeadAfter: pushed.remoteRef, at: now() });
        return { body, signature: ownerKeys.signStatement(body) };
      },
    });
  }
  return Object.freeze({ mode, authorize });
}
