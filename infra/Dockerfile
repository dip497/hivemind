# syntax=docker/dockerfile:1
# hive-net in a container: the server roles of a hivemind network (R13, `hive-net serve`), built
# from this repository. `infra/compose.yml` runs it; on its own:
#
#   docker build -f infra/Dockerfile -t hivemind/hive-net .
#   docker run -v hive-net:/data -p 3340:3340 hivemind/hive-net serve --all --data /data --url http://<address>:3340
FROM rust:1-bookworm AS build
WORKDIR /src
COPY crates/hive-net/ .
RUN cargo build --release --locked && cp target/release/hive-net /hive-net

# glibc and CA certificates, nothing else: no shell, no package manager.
FROM gcr.io/distroless/cc-debian12
COPY --from=build /hive-net /usr/local/bin/hive-net
VOLUME /data
ENTRYPOINT ["/usr/local/bin/hive-net"]
CMD ["serve", "--all", "--data", "/data"]
