# Image for Anthropic's OSS Scanner (https://github.com/anthropics/oss-scanner): the Hivemind monorepo,
# built as .github/workflows/ci.yml builds it, with every dependency fetched here so the unit tests
# run with no network afterwards:
#
#   pnpm test                                       every package's tests and the CLI's (bun test)
#   pnpm --filter @hivemind/desktop run test:unit   the desktop's unit tests
#   cargo test --offline                            in crates/hive-net, crates/hive-phone,
#                                                   crates/hive-phone-ffi, crates/agent-host
#
# No Electron e2e (it needs a display and a real agent CLI), and no secrets. threat_model.md, next
# to this file, says what matters.

# Node 24, as every Node job in ci.yml uses (package.json asks for >= 22).
FROM node:24-bookworm
ENV DEBIAN_FRONTEND=noninteractive

# git, ssh and ps are what the tests spawn; build-essential and python3 build a native addon that
# has no prebuilt binary; unzip is what Bun's installer needs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client procps unzip xz-utils \
      build-essential python3 pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Bun 1.4, as ci.yml's setup-bun pins.
ARG BUN_VERSION=1.4.3
ENV BUN_INSTALL=/usr/local/bun
ENV PATH=/usr/local/bun/bin:$PATH
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && bun --version

# Rust from rustup. rust-toolchain.toml at the repository root pins the version every crate builds
# with (and the wasm target the phone page needs), so the toolchain is installed from it below.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain none

# Commits the tests make need a name.
RUN git config --global user.name "oss-scanner" && git config --global user.email "oss-scanner@localhost"

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

ENV RUST_BACKTRACE=1 \
    CARGO_TERM_COLOR=never

# pnpm at the version packageManager names, then the workspace's dependencies.
RUN npm install --global "$(node -p "require('./package.json').packageManager")" \
    && pnpm --version \
    && pnpm install --frozen-lockfile

# The toolchain rust-toolchain.toml names, then every crate in every Cargo.lock, for every target,
# so later builds and tests stay offline.
RUN rustup toolchain install && rustc --version \
    && for lock in crates/Cargo.lock crates/*/Cargo.lock; do \
         cargo fetch --locked --manifest-path "$(dirname "$lock")/Cargo.toml" || exit 1; \
       done

# The build, as ci.yml's desktop job runs it: renderer, main process, views and the CLI. A step
# that fails fails the build.
RUN pnpm -r --parallel build

# hive-net's debug binary: the desktop's, the CLI's and the workspace host's network tests run it
# (without it they skip). Then each crate's test binaries, so `cargo test --offline` starts at once.
RUN cargo build --locked --manifest-path crates/hive-net/Cargo.toml \
    && for crate in hive-net hive-phone hive-phone-ffi agent-host; do \
         cargo test --locked --no-run --manifest-path "crates/$crate/Cargo.toml" || exit 1; \
       done

# Run the tests once so the log shows the image works, without letting a failure abort the build.
RUN (pnpm typecheck || echo "WARNING: pnpm typecheck reported errors") \
    && (pnpm test || echo "WARNING: pnpm test reported failures") \
    && (pnpm --filter @hivemind/desktop run test:unit || echo "WARNING: desktop test:unit reported failures") \
    && for crate in hive-net hive-phone hive-phone-ffi agent-host; do \
         (cd "crates/$crate" && timeout 900 cargo test --locked) || echo "WARNING: cargo test in crates/$crate reported failures"; \
       done

# Everything is fetched. From here on cargo must not reach a registry.
ENV CARGO_NET_OFFLINE=true

CMD ["bash"]
