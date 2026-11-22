FROM rust:1.95-alpine3.22 AS chef
RUN apk add --no-cache musl-dev \
 && cargo install cargo-chef --locked --version 0.1.78
WORKDIR /repo

FROM chef AS planner
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY services/storage/ services/storage/
COPY services/secrets/ services/secrets/
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS build
COPY rust-toolchain.toml ./
COPY --from=planner /repo/recipe.json recipe.json
RUN cargo chef cook --release --locked -p storage --recipe-path recipe.json
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY services/storage/ services/storage/
COPY services/secrets/ services/secrets/
RUN cargo build --release --locked -p storage --bin storage

FROM alpine:3.22
RUN addgroup -S -g 1000 storage \
 && adduser -S -D -H -u 1000 -G storage storage \
 && mkdir /data \
 && chown storage:storage /data
COPY --from=build /repo/target/release/storage /usr/local/bin/storage

ENV STORAGE_PORT=3001 \
    DATA_DIR=/data
USER storage
EXPOSE 3001
ENTRYPOINT ["storage"]
CMD ["serve"]
