# agent-host (Rust prototype)

The agent host's status fold and session hot path in Rust, held to the spec in `../../spec` and
the cases in `../../conformance`. Not used by the app: a Rust daemon replaces the TypeScript one
only when it passes the whole conformance suite and wins the benchmark
(`docs/design/agent-host-oss-2026-09-25.md`, S6).

```bash
cargo test --release                                     # conformance
cargo build --release --bin bench
target/release/bench 100 20 bench/stream.sh              # this host
node bench/node-bench.mjs 100 20 bench/stream.sh         # the TypeScript host, same work
```
