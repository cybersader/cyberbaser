# Iroh proposal-transfer fixture

Controlled local evidence that real Iroh connections can carry unchanged canonical `@cyberbaser/proposal` bytes over separately forced direct-IP and local-relay paths before queue-only handoff.

This spike uses a fixture-only chunked ALPN to make interruption and reconnect continuation deterministic. The ALPN is not a selected Cyberbaser protocol, and its resume behavior is not an Iroh core guarantee. The fixture starts an in-process test relay, reads no owner credentials, and performs no source write, Git mutation, publication, deployment, or production-network action.

```bash
bun install --frozen-lockfile
cargo test --locked
bun test test
bun run verify
```

A passing result is controlled local Linux carrier evidence only. It does not establish production readiness, public relay compatibility, real NAT traversal, hostile-network security, arbitrary crash durability, independent interoperability, offered intake, human usability, identity verification, owner decision UI, or source-write authority.
