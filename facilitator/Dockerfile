# Hemi x402 facilitator: x402-rs at e75adda plus the patches in x402-rs/patches/ (spec error shapes,
# see x402-rs/README.md). Built by `docker compose build` from the repo root; context is facilitator/.
#
# Works with the classic builder (no BuildKit features). Layers are ordered so that editing a patch
# only re-runs the last builder step: dependencies are compiled once, against unpatched x402-rs.

# rust:1.93-trixie (x402-rs needs Rust >= 1.93.0)
FROM rust@sha256:ecbe59a8408895edd02d9ef422504b8501dd9fa1526de27a45b73406d734d659 AS builder

ARG X402_RS_REPO=https://github.com/x402-rs/x402-rs.git
ARG X402_RS_COMMIT=e75adda8a0e3cf23db446883ba91b88bbab2fe28

WORKDIR /src
RUN git init -q . \
 && git remote add origin "$X402_RS_REPO" \
 && git fetch -q --depth 1 origin "$X402_RS_COMMIT" \
 && git checkout -q FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "$X402_RS_COMMIT"

# Build-only patch: an EVM-only workspace, so the build never fetches aptos-core. Not for upstream.
# Cargo.lock is then pruned to the remaining crates and checked to keep every version upstream locked.
COPY x402-rs/build/ /hemi/build/
RUN cp Cargo.lock /hemi/Cargo.lock.upstream \
 && for p in /hemi/build/*.patch; do \
      git apply --check "$p" && git apply "$p" || { echo "build patch does not apply: $p" >&2; exit 1; }; \
    done \
 && cargo fetch \
 && sh /hemi/build/check-lock-subset.sh /hemi/Cargo.lock.upstream Cargo.lock

# Compile the dependency graph (and unpatched x402-rs) once; cached until the build patch changes.
RUN cargo build --release --frozen -p x402-facilitator

# The upstreamable patches, applied in order. One that no longer applies fails the build here.
COPY x402-rs/patches/ /hemi/patches/
RUN for p in /hemi/patches/*.patch; do \
      echo "applying $(basename "$p")"; \
      git apply --check "$p" && git apply "$p" || { echo "patch does not apply: $p" >&2; exit 1; }; \
    done \
 && cargo build --release --frozen -p x402-facilitator

# debian:trixie-slim
FROM debian@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG X402_RS_COMMIT=e75adda8a0e3cf23db446883ba91b88bbab2fe28
LABEL org.opencontainers.image.title="hemi-x402-facilitator" \
      org.opencontainers.image.description="x402-rs facilitator with the hemi-x402 spec error-shape patches" \
      org.opencontainers.image.source="https://github.com/x402-rs/x402-rs" \
      org.opencontainers.image.revision="${X402_RS_COMMIT}"

WORKDIR /app
COPY --from=builder /src/target/release/x402-facilitator /usr/local/bin/x402-facilitator

ENV PORT=8080 RUST_LOG=info
EXPOSE 8080
ENTRYPOINT ["x402-facilitator"]
