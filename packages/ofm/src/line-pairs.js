// Align changed lines inside edit hunks, never by whole-document link counts.
// Bounded Myers alignment keeps large whole-file rewrites from consuming
// quadratic memory. If the bound is exceeded, do not infer replacements.
export function changedLinePairs(before, after) {
  const b = before.split('\n'), a = after.split('\n');
  const trace = [], frontier = new Map([[1, 0]]);
  for (let d = 0; d <= Math.min(b.length + a.length, 256); d++) {
    trace.push(new Map(frontier));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (frontier.get(k - 1) ?? -1) < (frontier.get(k + 1) ?? -1))
        ? (frontier.get(k + 1) ?? 0) : frontier.get(k - 1) + 1;
      let y = x - k;
      while (x < b.length && y < a.length && b[x] === a[y]) { x++; y++; }
      frontier.set(k, x);
      if (x >= b.length && y >= a.length) return pairHunks(b, a, anchors(trace, b.length, a.length));
    }
  }
  return [];
}

function anchors(trace, x, y) {
  const matches = [];
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d], k = x - y;
    const prevK = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? k + 1 : k - 1;
    const prevX = v.get(prevK) ?? 0, prevY = prevX - prevK;
    while (x > prevX && y > prevY) matches.push([--x, --y]);
    x = prevX; y = prevY;
  }
  return matches.reverse();
}

function pairHunks(b, a, matches) {
  const pairs = [];
  let bi = 0, ai = 0;
  for (const [bn, an] of [...matches, [b.length, a.length]]) {
    // Equal-length changed runs have a positional correspondence. Unequal
    // runs are ambiguous: leave them unpaired rather than hiding a removal.
    if (bn - bi === an - ai) {
      for (let i = 0; i < bn - bi; i++) pairs.push([b[bi + i], a[ai + i]]);
    }
    bi = bn + 1; ai = an + 1;
  }
  return pairs;
}
