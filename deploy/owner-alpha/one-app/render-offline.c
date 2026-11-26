// Linux/amd64 renderer launcher. Adds to, never replaces, the container's
// seccomp filter. Only standard I/O survives (including Bun's anonymous
// Unix stream pairs to its own child). No renderer can open a new socket or
// acquire one through another task, io_uring, SCM_RIGHTS or namespace changes.
#define _GNU_SOURCE
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/syscall.h>
#include <unistd.h>

#if !defined(__linux__) || !defined(__x86_64__) || defined(__ILP32__)
#error linux/amd64 required
#endif

#define DENY(nr) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_##nr, 0, 1), \
                 BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)

static int anonymous_stdio_pair(int fd) {
    struct sockaddr_un local, peer;
    socklen_t local_len = sizeof(local), peer_len = sizeof(peer), type_len = sizeof(int);
    int type;
    return getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &type_len) == 0 && type == SOCK_STREAM
        && getsockname(fd, (struct sockaddr *)&local, &local_len) == 0 && local.sun_family == AF_UNIX
        && getpeername(fd, (struct sockaddr *)&peer, &peer_len) == 0 && peer.sun_family == AF_UNIX
        && local_len == offsetof(struct sockaddr_un, sun_path) && peer_len == local_len;
}

int main(int argc, char **argv) {
    if (argc < 2 || argv[1][0] != '/') return 125;
    for (int fd = 0; fd < 3; fd++) {
        struct stat st;
        if (fstat(fd, &st) != 0) {
            if (errno == EBADF) continue;
            return 125;
        }
        if (S_ISSOCK(st.st_mode) && anonymous_stdio_pair(fd)) continue;
        if (!(S_ISFIFO(st.st_mode) || S_ISREG(st.st_mode))) {
            // Permit /dev/null, commonly supplied for stdin by the caller.
            struct stat null;
            if (stat("/dev/null", &null) != 0 || !S_ISCHR(st.st_mode) || st.st_rdev != null.st_rdev) return 125;
        }
    }
    if (syscall(SYS_close_range, 3U, ~0U, 0U) != 0) return 125;

    struct sock_filter rules[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000U, 0, 1), // reject x32 ABI
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        // Bun and esbuild use anonymous local pairs for subprocess stdio.
        // Neither end can be bound, connected to a name, or sent elsewhere.
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socketpair, 0, 4),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        // Bun uses sendto(fd, ..., NULL, 0) to write to the connected
        // subprocess pair. Never permit an addressed send, even for AF_UNIX.
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_sendto, 0, 8),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[4])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0U, 0, 5),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[4]) + 4U),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0U, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[5])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0U, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        DENY(socket), DENY(connect), DENY(bind), DENY(listen),
        DENY(accept), DENY(accept4), DENY(sendmsg), DENY(sendmmsg),
        DENY(recvmsg), DENY(recvmmsg), DENY(pidfd_getfd), DENY(ptrace),
        DENY(process_vm_readv), DENY(process_vm_writev), DENY(io_uring_setup),
        DENY(io_uring_enter), DENY(io_uring_register), DENY(setns), DENY(unshare),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = { .len = sizeof(rules) / sizeof(rules[0]), .filter = rules };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) != 0 ||
        syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0U, &program) != 0) {
        fputs("Could not enforce renderer socket isolation.\n", stderr);
        return 125;
    }
    execv(argv[1], argv + 1);
    return 126;
}
