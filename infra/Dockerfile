# syntax=docker/dockerfile:1
# hive-net in a container: the server roles of a hivemind network (R13, `hive-net serve`), and the
# phone page it serves at /phone/ (crates/hive-web), built from this repository.
# `infra/compose.yml` runs it; on its own:
#
#   docker build -f infra/Dockerfile -t hivemind/hive-net .
#   docker run -v hive-net:/data -p 3340:3340 -p 3341:3341 hivemind/hive-net serve --all --data /data --phone /phone --views 3341 --url http://<address>:3340
FROM rust:1-bookworm AS build
WORKDIR /src
COPY rust-toolchain.toml crates/hive-net/ .
RUN cargo build --release --locked && cp target/release/hive-net /hive-net

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
RUN tools=$(crates/hive-web/tools.sh /tools) && eval "$tools" && crates/hive-web/build.sh \
  && cd crates/hive-web/www && rm -rf app js tsconfig.json echo.html pkg/*.js pkg/*.d.ts pkg/package.json pkg/.gitignore

# glibc and CA certificates, nothing else: no shell, no package manager.
FROM gcr.io/distroless/cc-debian12
COPY --from=build /hive-net /usr/local/bin/hive-net
COPY --from=page /src/crates/hive-web/www /phone
VOLUME /data
ENTRYPOINT ["/usr/local/bin/hive-net"]
CMD ["serve", "--all", "--data", "/data", "--phone", "/phone", "--views", "3341"]
