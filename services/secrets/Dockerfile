FROM rust:1.95-alpine3.22 AS build
RUN apk add --no-cache musl-dev
WORKDIR /repo

COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY services/storage/ services/storage/
COPY services/secrets/ services/secrets/
RUN cargo build --release --locked -p secrets --bin secrets --bin secrets-operator

FROM alpine:3.22
RUN addgroup -S -g 1000 secrets \
 && adduser -S -D -H -u 1000 -G secrets secrets
COPY --from=build /repo/target/release/secrets /usr/local/bin/secrets
COPY --from=build /repo/target/release/secrets-operator /usr/local/bin/secrets-operator

ENV SECRETS_PORT=3002
USER secrets
EXPOSE 3002
ENTRYPOINT ["secrets"]
CMD ["serve"]
