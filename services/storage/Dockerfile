FROM rust:1.95-alpine3.22 AS build
RUN apk add --no-cache musl-dev
WORKDIR /repo

COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY services/storage/ services/storage/
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
