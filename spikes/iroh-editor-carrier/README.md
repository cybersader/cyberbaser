# Iroh owner editor carrier fixture

A real Rust Iroh 1.0.3 owner, `iroh-relay` library server, and Chromium Iroh WASM client. A Playwright virtual CTAP2 authenticator creates a throwaway WebAuthn passkey. Only its public key goes to the owner. The owner and browser independently derive the assertion challenge from the connection's TLS exporter. Neither command accesses a vault, writes an edit, or publishes. All network listeners (relay and two synthetic static origins) bind IPv4 loopback; the owner uses no direct IP transport or discovery.

From the repository root:

```sh
build-contained -- bash spikes/iroh-editor-carrier/run.sh
```

Prerequisites: Node.js 22+, the docs' installed `playwright` and its Chromium, rustup, and Clang capable of compiling `wasm32-unknown-unknown`. The Rust target is pinned in `rust-toolchain.toml`. The runner uses wasm-bindgen CLI 0.2.128 or installs it under the ignored `.tools/` directory. If Clang is elsewhere, set `CC_wasm32_unknown_unknown` to its absolute executable path. If using an existing docs install from a separate checkout, set `DOCS_NODE_MODULES` to its absolute directory. `WASM_BINDGEN` can point at a matching CLI explicitly.

The harness checks the selected path and relay dependency, rejects commands without a principal, checks different-channel and same-channel replay, checks signature and exact origin, and exercises both fake commands plus the JSON frame bound. It prints one connection setup time and the min, median, p95, and max for 50 sequential warm echo requests, measured inside Chromium. The fixture uses loopback HTTP/WS, not a deployed HTTPS/WSS setup; the relayed Iroh connection still runs end-to-end QUIC/TLS. The minimal assertion verifier, in-memory enrollment, fixture ALPN and command names are not for production.
