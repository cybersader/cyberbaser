/** Compare selector and projection output by source identity, not by address alone. */
export function comparePublicationEffects(baseline, candidate) {
  const beforeSet = new Set(baseline.published);
  const afterSet = new Set(candidate.published);
  const added = [...afterSet].filter((source) => !beforeSet.has(source)).sort();
  const removed = [...beforeSet].filter((source) => !afterSet.has(source)).sort();

  const before = baseline.addresses;
  const after = candidate.addresses;
  const addresses = { changed: false, added: [], removed: [], moved: [] };
  for (const source of [...before.keys()].sort()) {
    if (!after.has(source)) {
      addresses.removed.push(source);
    } else if (before.get(source) !== after.get(source)) {
      addresses.moved.push({ source, from: before.get(source), to: after.get(source) });
    }
  }
  for (const source of [...after.keys()].sort()) {
    if (!before.has(source)) addresses.added.push(source);
  }
  addresses.changed = addresses.added.length + addresses.removed.length + addresses.moved.length > 0;

  return {
    publicSet: { changed: added.length + removed.length > 0, added, removed },
    addresses,
  };
}
