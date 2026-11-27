// Linux/amd64 renderer launcher. Landlock restricts filesystem writes and
// cross-domain process access before we add a renderer-only seccomp filter.
// Only standard I/O survives (including Bun's anonymous Unix stream pairs).
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/openat2.h>
#include <linux/seccomp.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/un.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#if !defined(__linux__) || !defined(__x86_64__) || defined(__ILP32__)
#error linux/amd64 required
#endif

// The legacy image compiles with Debian 12 userspace headers. These kernel
// ABI values are fixed for x86-64; the running kernel must still support ABI 6.
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)
#endif
#ifndef LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET
#define LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0)
#define LANDLOCK_SCOPE_SIGNAL (1ULL << 1)
#endif
#ifndef SYS_fchmodat2
#define SYS_fchmodat2 452
#endif
#ifndef SYS_setxattrat
#define SYS_setxattrat 463
#endif
#ifndef SYS_removexattrat
#define SYS_removexattrat 466
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

static int add_path(int ruleset, int fd, uint64_t access) {
    struct landlock_path_beneath_attr path = { .allowed_access = access, .parent_fd = fd };
    return syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &path, 0U);
}

static int writable_tree(int ruleset, const char *dir, uint64_t access) {
    if (dir[0] != '/' || dir[1] == '\0') return -1;
    // Refuse all symlink components, not merely the final component. Hold the
    // opened inode while adding the rule instead of looking up the path again.
    struct open_how how = { .flags = O_PATH | O_DIRECTORY | O_CLOEXEC, .resolve = RESOLVE_NO_SYMLINKS };
    int fd = syscall(SYS_openat2, AT_FDCWD, dir, &how, sizeof(how));
    if (fd < 0) return -1;
    int result = add_path(ruleset, fd, access);
    close(fd);
    return result;
}

static int allow_null_sink(int ruleset) {
    // Shell and Git reopen /dev/null. Allow the actual null device only,
    // not general writes to device nodes or anything under /dev.
    int fd = open("/dev/null", O_PATH | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return -1;
    struct stat st;
    int result = -1;
    if (fstat(fd, &st) == 0 && S_ISCHR(st.st_mode) && major(st.st_rdev) == 1 && minor(st.st_rdev) == 3) {
        result = add_path(ruleset, fd, LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE);
    }
    close(fd);
    return result;
}

static int restrict_renderer(const char *workspace, const char *output, const char *cache) {
    // v3 covers truncate; v6 adds cross-domain signal and abstract socket
    // scoping. Landlock also denies ptrace across the boundary (including
    // procfs task-memory access), independently of the Yama setting.
    int abi = syscall(SYS_landlock_create_ruleset, NULL, 0U, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 6) return -1;
    const uint64_t write_tree = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR
        | LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG
        | LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_SYM | LANDLOCK_ACCESS_FS_REFER
        | LANDLOCK_ACCESS_FS_TRUNCATE;
    const struct {
        uint64_t handled_access_fs;
        uint64_t handled_access_net;
        uint64_t scoped;
    } attr = {
        .handled_access_fs = write_tree | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_BLOCK
            | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_IOCTL_DEV,
        .scoped = LANDLOCK_SCOPE_SIGNAL | LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET,
    };
    int ruleset = syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr), 0U);
    if (ruleset < 0) return -1;
    int result = -1;
    if (writable_tree(ruleset, workspace, write_tree) == 0 && writable_tree(ruleset, output, write_tree) == 0
        && (!cache || writable_tree(ruleset, cache, write_tree) == 0) && allow_null_sink(ruleset) == 0) {
        result = syscall(SYS_landlock_restrict_self, ruleset, 0U);
    }
    close(ruleset);
    return result;
}

static int render(char **command, const char *workspace, const char *output, const char *cache) {
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
    if (prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) != 0 || restrict_renderer(workspace, output, cache) != 0) {
        fputs("Could not enforce renderer Landlock isolation (ABI 6 and default-profile syscall access required).\n", stderr);
        return 125;
    }

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
        // Only ordinary clone/fork, not new namespaces. ENOSYS lets libc
        // fall back from clone3 (pointer arguments) to the filterable clone.
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone3, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone, 0, 4),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, CLONE_NEWCGROUP | CLONE_NEWIPC | CLONE_NEWNET |
                 CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWUSER | CLONE_NEWUTS, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        DENY(socket), DENY(connect), DENY(bind), DENY(listen),
        DENY(accept), DENY(accept4), DENY(sendmsg), DENY(sendmmsg),
        DENY(recvmsg), DENY(recvmmsg), DENY(pidfd_getfd), DENY(ptrace),
        DENY(process_vm_readv), DENY(process_vm_writev), DENY(io_uring_setup),
        DENY(io_uring_enter), DENY(io_uring_register), DENY(setns), DENY(unshare),
        // Landlock does not mediate these metadata mutations. Refuse them
        // even when the node and renderer have the same numeric owner.
        DENY(chmod), DENY(fchmod), DENY(fchmodat), DENY(fchmodat2),
        DENY(chown), DENY(fchown), DENY(lchown), DENY(fchownat),
        DENY(setxattr), DENY(lsetxattr), DENY(fsetxattr), DENY(setxattrat),
        DENY(removexattr), DENY(lremovexattr), DENY(fremovexattr), DENY(removexattrat),
        DENY(utime), DENY(utimes), DENY(futimesat), DENY(utimensat),
        DENY(fallocate),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = { .len = sizeof(rules) / sizeof(rules[0]), .filter = rules };
    if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0U, &program) != 0) {
        fputs("Could not enforce renderer socket isolation.\n", stderr);
        return 125;
    }
    execv(command[0], command);
    fputs("Could not execute the isolated renderer.\n", stderr);
    return 126;
}

#ifndef RENDER_TIMEOUT_SECONDS
#define RENDER_TIMEOUT_SECONDS 600
#endif

static volatile sig_atomic_t stopping;
static void stop(int sig) { stopping = sig; }

// The supervisor is single-threaded and never auto-reaps. Any PID listed as
// its child cannot be recycled while we signal it, even if it just exited.
// Linux may omit a task being reparented from this listing; only waitpid's
// ECHILD (never an empty file) is evidence that the entire tree is gone.
static int finish_tree(pid_t leader) {
    (void)kill(-leader, SIGKILL); // leader has not yet been reaped
    (void)kill(leader, SIGKILL);  // also handle cancellation during setpgid
    const struct timespec pause_time = { .tv_nsec = 10000000L };
    for (int attempt = 0; attempt < 500; attempt++) {
        for (int reaped = 0; reaped < 128; reaped++) {
            const pid_t child = waitpid(-1, NULL, WNOHANG | __WALL);
            if (child < 0 && errno == ECHILD) return 0;
            if (child <= 0) break;
        }
        FILE *children = fopen("/proc/thread-self/children", "re");
        if (children) {
            int pid;
            while (fscanf(children, "%d", &pid) == 1 && pid > 0) {
                siginfo_t info = {0};
                if (waitid(P_PID, (id_t)pid, &info, WEXITED | WNOHANG | WNOWAIT | __WALL) == 0) {
                    (void)kill((pid_t)pid, SIGKILL);
                }
            }
            fclose(children);
        }
        (void)nanosleep(&pause_time, NULL);
    }
    return -1;
}

int main(int argc, char **argv) {
    // Only the trusted node supplies the workspace and output. An optional
    // native custom renderer cache grant is disjoint from the node's trees.
    int command = 4;
    const char *cache = NULL;
    if (argc >= 7 && strcmp(argv[3], "--renderer-cache") == 0) {
        cache = argv[4];
        command = 6;
    }
    if (argc <= command || strcmp(argv[command - 1], "--") != 0 || argv[command][0] != '/') return 125;

    // Refuse a procfs mounted for a different PID namespace. Cleanup must
    // never signal PID numbers interpreted in another namespace.
    char proc_pid[32], own_pid[32];
    snprintf(own_pid, sizeof(own_pid), "%ld", (long)getpid());
    ssize_t proc_len = readlink("/proc/self", proc_pid, sizeof(proc_pid));
    if (proc_len != (ssize_t)strlen(own_pid) || memcmp(proc_pid, own_pid, (size_t)proc_len) != 0
        || access("/proc/thread-self/children", R_OK) != 0) return 125;

    const pid_t parent = getppid();
    const struct sigaction cancelled = { .sa_handler = stop };
    const struct sigaction normal = { .sa_handler = SIG_DFL };
    if (sigaction(SIGCHLD, &normal, NULL) || sigaction(SIGTERM, &cancelled, NULL)
        || sigaction(SIGINT, &cancelled, NULL) || sigaction(SIGHUP, &cancelled, NULL)
        || sigaction(SIGALRM, &cancelled, NULL) || prctl(PR_SET_CHILD_SUBREAPER, 1L, 0L, 0L, 0L)
        || prctl(PR_SET_PDEATHSIG, (long)SIGTERM, 0L, 0L, 0L) || getppid() != parent) return 125;
    if (syscall(SYS_close_range, 3U, ~0U, 0U) != 0) return 125;

    const pid_t supervisor = getpid();
    const pid_t leader = fork();
    if (leader < 0) return 125;
    if (leader == 0) {
        if (setpgid(0, 0) || prctl(PR_SET_PDEATHSIG, (long)SIGKILL, 0L, 0L, 0L)
            || getppid() != supervisor) _exit(125);
        _exit(render(argv + command, argv[1], argv[2], cache));
    }
    alarm(RENDER_TIMEOUT_SECONDS);
    siginfo_t info = {0};
    // Poll without reaping the leader: a signal delivered just before wait
    // must not lose cancellation, and the group ID must not be recycled.
    int wait_error = 0;
    const struct timespec pause_time = { .tv_nsec = 10000000L };
    while (!stopping) {
        if (waitid(P_PID, (id_t)leader, &info, WEXITED | WNOWAIT | WNOHANG) != 0) {
            if (errno == EINTR) continue;
            wait_error = 1;
            break;
        }
        if (info.si_pid == leader) break;
        (void)nanosleep(&pause_time, NULL);
    }
    alarm(0);
    if (finish_tree(leader) != 0 || wait_error) {
        fputs("Could not verify renderer process tree cleanup.\n", stderr);
        return 125;
    }
    if (stopping) {
        fputs("Renderer build cancelled or timed out.\n", stderr);
        return stopping == SIGALRM ? 124 : 128 + stopping;
    }
    return info.si_code == CLD_EXITED ? info.si_status : 128 + info.si_status;
}
