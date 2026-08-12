export function createGlobalAbuseLimiter({
  capacity = 20,
  refillPerSecond = 1,
  maxConcurrent = 4,
  now = () => performance.now(),
} = {}) {
  let tokens = capacity;
  let lastRefill = now();
  let active = 0;

  function refill() {
    const current = now();
    const elapsedSeconds = Math.max(0, current - lastRefill) / 1000;
    tokens = Math.min(capacity, tokens + elapsedSeconds * refillPerSecond);
    lastRefill = current;
  }

  return Object.freeze({
    tryTake() {
      refill();
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    tryEnter() {
      if (active >= maxConcurrent) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
      };
    },
    snapshot() {
      refill();
      return Object.freeze({ tokens, active });
    },
  });
}
