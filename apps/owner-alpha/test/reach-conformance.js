import { expect, test } from 'bun:test';

/** Register a carrier against the ingress contract. The adapter returns actual
 * bound numeric socket addresses, not a copy of its input selection. */
export function checkReachConformance(name, open, { localIPv4, absentIPv4 }) {
  test(`${name}: direct keeps its wildcard IPv4 bind`, async () => {
    const binding = await open('direct');
    try {
      expect(binding.sockets).toContainEqual(expect.stringMatching(/^0\.0\.0\.0:[1-9]\d*$/u));
    } finally { await binding.close(); }
  });

  for (const [selection, expectedIPv4, advertisesDirect] of [
    ['relay-only', '127.0.0.1', false], [`private-address:${localIPv4}`, localIPv4, true],
  ]) {
    test(`${name}: ${selection} confines binds and direct advertisements`, async () => {
      const binding = await open(selection);
      try {
        const ipv4 = binding.sockets.filter((socket) => socket.startsWith(`${expectedIPv4}:`));
        expect(ipv4).toHaveLength(1);
        expect(ipv4[0].split(':')[1]).toMatch(/^[1-9]\d*$/u);
        const other = binding.sockets.filter((socket) => socket !== ipv4[0]);
        expect(other.length).toBeLessThanOrEqual(1);
        for (const socket of other) expect(socket).toMatch(/^\[::1\]:[1-9]\d*$/u);
        expect(binding.advertisedDirect).toEqual(advertisesDirect ? ipv4 : []);
      } finally { await binding.close(); }
    });
  }

  test(`${name}: an unavailable address fails instead of falling back`, async () => {
    await expect((async () => {
      const binding = await open(`private-address:${absentIPv4}`);
      await binding.close();
    })()).rejects.toThrow();
  });
}
