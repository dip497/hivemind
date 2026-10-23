# syntax=docker/dockerfile:1
# hive-net in a container: the server roles of a hivemind network (R13, `hive-net serve`), and the
# phone page it carries and serves at /phone/ (crates/hive-web), built from this repository.
# `infra/compose.yml` runs it; on its own:
#
#   docker build -f infra/Dockerfile -t hivemind/hive-net .
#   docker run -v hive-net:/data -p 3340:3340 -p 3341:3341 hivemind/hive-net serve --all --data /data --phone --views 3341 --url http://<address>:3340
# The phone page, as crates/hive-web/build.sh builds it, with the tools at the versions the
# repository pins (crates/hive-web/tools.sh): the same bytes, and hash, as the release's.
FROM node:24-bookworm AS page
RUN apt-get update && apt-get install -y --no-install-recommends brotli && rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
ENV PATH=/root/.cargo/bin:$PATH
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml rust-toolchain.toml .
COPY spec/ spec/
COPY crates/Cargo.toml crates/Cargo.lock crates/
COPY crates/hive-net/ crates/hive-net/
COPY crates/hive-phone/ crates/hive-phone/
COPY crates/hive-web/ crates/hive-web/
COPY crates/vendor/ crates/vendor/
# Only www/ is kept, as for the build above: not the target dir, the tools, the crates or the Rust.
RUN tools=$(crates/hive-web/tools.sh /tools) && eval "$tools" && crates/hive-web/build.sh \
  && rm -rf /src/crates/target /tools /root/.cargo/registry /root/.rustup/toolchains \
  && cd crates/hive-web/www && rm -rf app js tsconfig.json echo.html pkg/*.js pkg/*.d.ts pkg/package.json pkg/.gitignore

# hive-net, carrying that page (build.rs): the server serves the page it was built with.
FROM rust:1-bookworm AS build
WORKDIR /src
COPY rust-toolchain.toml crates/hive-net/ .
COPY --from=page /src/crates/hive-web/www /phone
# The build's own files go with it: only the binary is kept, so the cached layer is not the target
# dir, the crates it downloaded or the Rust rust-toolchain.toml installed.
RUN HIVE_NET_PHONE_PAGE=/phone cargo build --release --locked && cp target/release/hive-net /hive-net \
  && rm -rf target "$CARGO_HOME/registry" "$(rustc --print sysroot)"

# glibc and CA certificates, nothing else: no shell, no package manager.
FROM gcr.io/distroless/cc-debian12
COPY --from=build /hive-net /usr/local/bin/hive-net
VOLUME /data
ENTRYPOINT ["/usr/local/bin/hive-net"]
CMD ["serve", "--all", "--data", "/data", "--phone", "--views", "3341"]
