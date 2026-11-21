// All currently implemented grants are owner-only. `review` includes recording
// an approval decision; `publication` includes preparing a private draft.
export const OWNER_GRANTS = Object.freeze(['read', 'save', 'review', 'apply', 'publication', 'publish']);

export function actorAllowsGrant(kind, grant) {
  return kind === 'owner-device' && OWNER_GRANTS.includes(grant);
}
