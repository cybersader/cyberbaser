// `review` includes approval. `publication` includes preparing a private
// draft. A device may also propose, but proposing confers no other grant.
export const OWNER_GRANTS = Object.freeze(['read', 'save', 'review', 'apply', 'publication', 'publish', 'propose']);

export function actorAllowsGrant(kind, grant) {
  return kind === 'agent' ? grant === 'propose' : kind === 'owner-device' && OWNER_GRANTS.includes(grant);
}
