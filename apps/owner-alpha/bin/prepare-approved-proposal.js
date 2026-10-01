#!/usr/bin/env bun
// Prepare the input artifact for one approved proposal, locally, on demand.
//
//   bun apps/owner-alpha/bin/prepare-approved-proposal.js <owner-alpha config> <queueId>
//   bun apps/owner-alpha/bin/prepare-approved-proposal.js <owner-alpha config> --list
//
// Exit codes: 0 prepared or replayed, 2 not eligible (stale), 1 error.
// This writes only under the private owner store. It starts no job, applies
// no source, and touches no Git ref. There is deliberately no HTTP route.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OwnerAlphaError,
  listApprovedProposalInputs,
  loadOwnerAlphaConfig,
  prepareApprovedProposalInput,
  prepareStore,
  storeContextFromConfig,
} from '../src/index.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const [configArgument, target] = process.argv.slice(2);

function usage() {
  process.stderr.write('usage: prepare-approved-proposal.js <owner-alpha config> <queueId | --list>\n');
  process.exit(1);
}

if (!configArgument || !target) usage();

try {
  const config = await loadOwnerAlphaConfig(path.resolve(configArgument));
  const context = storeContextFromConfig(config, PROJECT_ROOT);
  await prepareStore(context);
  if (target === '--list') {
    const inputs = await listApprovedProposalInputs(context);
    process.stdout.write(`${JSON.stringify(inputs.map((input) => ({
      queueId: input.queueId,
      preparedAt: input.preparedAt,
      path: input.source.path,
      branchTip: input.source.branchTip,
      applicationGate: input.applicationGate.state,
    })), null, 2)}\n`);
    process.exit(0);
  }
  const result = await prepareApprovedProposalInput({ context, config, queueId: target });
  process.stdout.write(`${JSON.stringify({
    queueId: target,
    prepared: result.prepared,
    replayed: result.replayed,
    eligibility: result.eligibility,
    applicationGate: result.input?.applicationGate.state ?? null,
    candidateDigest: result.input?.candidate.digest ?? null,
  }, null, 2)}\n`);
  process.exit(result.prepared ? 0 : 2);
} catch (error) {
  const code = error instanceof OwnerAlphaError ? error.code : 'unexpected-error';
  process.stderr.write(`prepare-approved-proposal failed: ${code}\n`);
  process.exit(1);
}
