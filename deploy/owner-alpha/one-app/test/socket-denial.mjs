// Lab-only. A syscall denied with EPERM is distinct from a failed outbound
// connection due to no routes, or from AF_UNIX/NETLINK being unavailable.
import { dlopen, ptr, read } from 'bun:ffi';
import { readFileSync } from 'node:fs';

const { symbols: c } = dlopen('libc.so.6', {
  socket: { args: ['int', 'int', 'int'], returns: 'int' },
  connect: { args: ['int', 'ptr', 'u32'], returns: 'int' },
  sendto: { args: ['int', 'ptr', 'u64', 'int', 'ptr', 'u32'], returns: 'int' },
  __errno_location: { args: [], returns: 'ptr' },
});
const errno = c.__errno_location();
const restricted = process.argv.includes('--restricted');
const protocolFamilies = [[2, 1], [10, 1], [16, 3], [1, 1]]; // inet, inet6, netlink, unix
for (const [family, type] of protocolFamilies) {
  const fd = c.socket(family, type, 0);
  if (restricted ? fd !== -1 || read.i32(errno) !== 1 : fd < 0) process.exit(1);
}
if (restricted) {
  // No socket can be handed to this process. Even a direct connect syscall,
  // before descriptor validation (normally EBADF), is blocked by seccomp.
  if (c.connect(-1, null, 0) !== -1 || read.i32(errno) !== 1) process.exit(1);
  const address = new Uint8Array(16);
  if (c.sendto(-1, null, 0n, 0, ptr(address), address.length) !== -1 || read.i32(errno) !== 1) process.exit(1);
  if (c.sendto(-1, null, 0n, 0, null, 0) !== -1 || read.i32(errno) !== 9) process.exit(1);
  const filters = /^Seccomp_filters:\s+(\d+)$/m.exec(readFileSync('/proc/self/status', 'utf8'));
  const minimum = process.argv.includes('--host-probe') ? 1 : 2;
  if (!filters || Number(filters[1]) < minimum) process.exit(1);
  // A build may pipe output from its own child. Anonymous AF_UNIX pairs
  // support that; the child inherits the same filter.
  const child = Bun.spawnSync(['/usr/bin/printf', 'anonymous-pipe-ok'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  if (!child.success || child.stdout.toString() !== 'anonymous-pipe-ok') process.exit(1);
}
