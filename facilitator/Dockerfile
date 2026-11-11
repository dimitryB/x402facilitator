# Hemi x402 facilitator: x402-rs at e75adda plus the patches in x402-rs/patches/ (spec error shapes,
# see x402-rs/README.md) and the Bitcoin chain crate in x402-rs/crates/x402-chain-bip122/ (exact BTC
# payments recorded on Hemi). Built by `docker compose build` from the repo root; context is facilitator/.
#
# Works with the classic builder (no BuildKit features). Layers are ordered so that editing a patch or
# the crate's sources only re-runs the last builder step: dependencies are compiled once, against
# unpatched x402-rs.

# rust:1.94.1-trixie. x402-rs needs Rust 1.93 or later; alloy 2.5, in build/Cargo.lock, needs 1.94.1 (D-049).
FROM rust@sha256:652612f07bfbbdfa3af34761c1e435094c00dde4a98036132fca28c7bb2b165c AS builder

ARG X402_RS_REPO=https://github.com/x402-rs/x402-rs.git
ARG X402_RS_COMMIT=e75adda8a0e3cf23db446883ba91b88bbab2fe28

WORKDIR /src
RUN git init -q . \
 && git remote add origin "$X402_RS_REPO" \
 && git fetch -q --depth 1 origin "$X402_RS_COMMIT" \
 && git checkout -q FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "$X402_RS_COMMIT"

# The Bitcoin chain crate is a workspace member (build patch). Only its manifest is needed to resolve
# and compile dependencies, so its sources come after the dependency layer; a stub stands in until then.
COPY x402-rs/crates/x402-chain-bip122/Cargo.toml /src/crates/chains/x402-chain-bip122/Cargo.toml
RUN mkdir -p /src/crates/chains/x402-chain-bip122/src \
 && touch /src/crates/chains/x402-chain-bip122/src/lib.rs

# Build-only patch: an EVM-only workspace, so the build never fetches aptos-core, plus the Bitcoin
# crate and its `bitcoin` dependency. Not for upstream. The lock is build/Cargo.lock: upstream's, pruned
# to the remaining crates, with the packages `bitcoin` adds and the security upgrades (D-047). Cargo
# refuses it if it does not match the manifests (--locked), and the check refuses any package that is
# not in upstream's lock, build/lock-additions.txt or build/lock-upgrades.txt.
COPY x402-rs/build/ /hemi/build/
RUN cp Cargo.lock /hemi/Cargo.lock.upstream \
 && for p in /hemi/build/*.patch; do \
      git apply --check "$p" && git apply "$p" || { echo "build patch does not apply: $p" >&2; exit 1; }; \
    done \
 && cp /hemi/build/Cargo.lock Cargo.lock \
 && cargo fetch --locked \
 && sh /hemi/build/check-lock-subset.sh /hemi/Cargo.lock.upstream Cargo.lock \
      /hemi/build/lock-additions.txt /hemi/build/lock-upgrades.txt

# Compile the dependency graph (and unpatched x402-rs) once; cached until the build patch changes.
# `bitcoin` is compiled on its own: the crate that uses it needs patches 0029 and 0030.
RUN cargo build --release --frozen -p x402-facilitator \
 && cargo build --release --frozen -p bitcoin

# The upstreamable patches, applied in order. One that no longer applies fails the build here. Then
# the Bitcoin crate's sources, and the binary with the bip122 chain (patch 0030's feature).
COPY x402-rs/patches/ /hemi/patches/
COPY x402-rs/crates/x402-chain-bip122/ /src/crates/chains/x402-chain-bip122/
RUN for p in /hemi/patches/*.patch; do \
      echo "applying $(basename "$p")"; \
      git apply --check "$p" && git apply "$p" || { echo "patch does not apply: $p" >&2; exit 1; }; \
    done \
 && cargo build --release --frozen -p x402-facilitator --features chain-bip122

# debian:trixie-slim of 2026-11-04, with apt 3.0.4 (CVE-2026-109518 fixed; DECISIONS.md D-047)
FROM debian@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2

# No apt-get in this stage: the service needs only the CA certificates, and installing them fetched
# packages over HTTP while the image was built. The bundle comes from the builder image instead.
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
# The service needs no root: it listens on 8080 and only reads its config.
RUN useradd --system --uid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin facilitator

ARG X402_RS_COMMIT=e75adda8a0e3cf23db446883ba91b88bbab2fe28
LABEL org.opencontainers.image.title="hemi-x402-facilitator" \
      org.opencontainers.image.description="x402-rs facilitator with the hemi-x402 spec error-shape patches and the exact bip122 scheme" \
      org.opencontainers.image.source="https://github.com/dimitryB/x402facilitator" \
      org.opencontainers.image.licenses="Apache-2.0" \
      x402-rs.source="https://github.com/x402-rs/x402-rs" \
      x402-rs.revision="${X402_RS_COMMIT}"

WORKDIR /app
COPY --from=builder /src/target/release/x402-facilitator /usr/local/bin/x402-facilitator
USER 10001:10001

ENV PORT=8080 RUST_LOG=info
EXPOSE 8080
ENTRYPOINT ["x402-facilitator"]
