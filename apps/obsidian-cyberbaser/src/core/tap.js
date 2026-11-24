// A signature needs a real tap in this plugin's own dialog.
//
// Obsidian runs every plugin in one page, so another plugin can call this
// plugin's methods or dispatch a synthetic click on its button. Neither counts:
// the browser marks only events from real input as trusted, and this reads
// that mark with the genuine Event.prototype getter, captured before any other
// plugin's code runs, so an object that merely claims `isTrusted: true` fails.
// Each tap signs at most once.
//
// What this does not stop: code in the same page that reads the key from
// IndexedDB itself (non-extractable keys can still be used by the page). That
// residual risk is recorded in design/signed-publish.mdx.

const trustedGetter = (() => {
  try {
    return Object.getOwnPropertyDescriptor(globalThis.Event?.prototype ?? {}, 'isTrusted')?.get
      ?? Object.getOwnPropertyDescriptor(new globalThis.Event('probe'), 'isTrusted')?.get ?? null;
  } catch { return null; }
})();
const PointerLike = globalThis.MouseEvent ?? null;

export function isRealTap(event) {
  if (trustedGetter === null || PointerLike === null || !(event instanceof PointerLike)) return false;
  try {
    // Brand-checked: throws for anything that is not a genuine Event.
    return trustedGetter.call(event) === true && event.type === 'click';
  } catch { return false; }
}

export class TapRequired extends Error {
  constructor() { super('tap-required'); this.reason = 'tap-required'; }
}

/** One gate per plugin instance. `check` is replaceable only by tests. */
export function createTapGate(check = isRealTap) {
  const used = new WeakSet();
  return Object.freeze({
    consume(event) {
      if (event === null || typeof event !== 'object' || used.has(event) || check(event) !== true) throw new TapRequired();
      used.add(event);
    },
  });
}
