# Diaphani — self-contained run container.
#
# WHY a container is the default: the container IS the network namespace, so nym's
# kill-switch + tunnel are confined to it, nym's gateway/api resolution goes over its OWN
# DoH resolver (which it permits — no plain-udp/53-vs-DoH-only deadlock like a bare host
# netns), and a bad run is just `docker rm`, never a wedged host. NOTE: a libc lookup does
# NOT use nym's DoH — it would hit Docker's 127.0.0.11 and forward upstream from the HOST
# netns, outside the mask. So the node is given ZERO hostnames to resolve: every bootstrap
# peer must be an /ip4|/ip6 literal (the CLI + entrypoint reject /dns* peers) and NTP is a
# literal IP, so the node's resolver never issues a query; the only resolv.conf reader is
# nym's own entry-side control plane (already exposed to nym by design). ubuntu:24.04
# also gives glibc 2.39, so it runs the node + nym-vpn on ANY Docker host regardless of
# the host's glibc.
#
# Everything that egresses (the node's QUIC) goes node -> nym -> peers, masked: the node
# is routed straight through the nym tunnel (peers listen on nym-allowed udp ports). tor
# runs in the same container but is UID-routed to clearnet for the inbound .onion only;
# the node's own traffic stays forced through nym.
# Pinned by DIGEST, not the floating `24.04` tag: the run container is privileged, IS the
# network namespace, and bind-mounts the decrypted mnemonic — a re-pushed/tampered base
# would defeat the masking + exfiltrate the secret. Bump this digest DELIBERATELY (resolve
# with `docker buildx imagetools inspect ubuntu:24.04`); dependabot's docker ecosystem keeps
# it current. The artifacts below are likewise sha256-pinned + `sha256sum -c`'d.
FROM ubuntu:26.04@sha256:f3d28607ddd78734bb7f71f117f3c6706c666b8b76cbff7c9ff6e5718d46ff64

ARG NYM_VER=1.30.0
ARG NODE_VER=0.1.2
ARG CIRCUITS_VER=v0.4.2
ARG TARGET=x86_64

# Pinned SHA-256 (x86_64) — verified out-of-band; checked at image-build time below
# (each artifact `sha256sum -c`'d after download).
ARG NODE_SHA=6c0aaf2e2d732dfe4b46a649f9e3e96e66f5ba36bff436325da26c99b4fa3ed8
ARG CIRCUITS_SHA=e9131ffac8b08a80e1a7152b34fdd5d5c52674d4cb396e8162131ca5dd7c858d
ARG NYM_SHA=cbb23bf1236d915e5b2441427fd428d9675fbe672ceaac8f15781a7f95148a8e

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      tor curl ca-certificates iproute2 iptables nftables iputils-ping \
      dnsutils procps gawk sed grep coreutils tar gzip && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/dl
# nym-vpn (nym-vpnd + nym-vpnc)
RUN url="https://github.com/nymtech/nym-vpn-client/releases/download/nym-vpn-core-v${NYM_VER}/nym-vpn-core-v${NYM_VER}_linux_${TARGET}.tar.gz" && \
    curl -fSL --retry 3 "$url" -o nym.tgz && \
    echo "${NYM_SHA}  nym.tgz" | sha256sum -c - && \
    tar -xzf nym.tgz && \
    install -m755 "$(find . -type f -name nym-vpnd | head -1)" /usr/local/bin/nym-vpnd && \
    install -m755 "$(find . -type f -name nym-vpnc | head -1)" /usr/local/bin/nym-vpnc && \
    rm -rf /tmp/dl/*
# logos node
RUN url="https://github.com/logos-blockchain/logos-blockchain/releases/download/${NODE_VER}/logos-blockchain-node-linux-${TARGET}-${NODE_VER}.tar.gz" && \
    curl -fSL --retry 3 "$url" -o node.tgz && \
    echo "${NODE_SHA}  node.tgz" | sha256sum -c - && \
    tar -xzf node.tgz && \
    install -m755 -D "$(find . -type f -name logos-blockchain-node | head -1)" /opt/logos/logos-blockchain-node && \
    rm -rf /tmp/dl/*
# circuits
RUN url="https://github.com/logos-blockchain/logos-blockchain/releases/download/${NODE_VER}/logos-blockchain-circuits-${CIRCUITS_VER}-linux-${TARGET}.tar.gz" && \
    curl -fSL --retry 3 "$url" -o circ.tgz && \
    echo "${CIRCUITS_SHA}  circ.tgz" | sha256sum -c - && \
    tar -xzf circ.tgz && \
    src="$(dirname "$(find . -name VERSION | head -1)")" && \
    mkdir -p /opt/logos/circuits && cp -a "$src"/. /opt/logos/circuits/ && \
    rm -rf /tmp/dl/*

# nym-vpnd links D-Bus (libdbus-1.so.3) and uses the system bus in run-as-service
# mode. Separate layer AFTER the downloads so editing it doesn't re-fetch the deps.
RUN apt-get update && apt-get install -y --no-install-recommends libdbus-1-3 dbus && \
    rm -rf /var/lib/apt/lists/*

COPY docker/entrypoint.sh /usr/local/bin/diaphani-entrypoint
RUN chmod 755 /usr/local/bin/diaphani-entrypoint

# Persisted at runtime via volumes: /diaphani/secrets (nym.txt, ro),
# /diaphani/data (node db + generated config), /diaphani/onion (v3 onion keys).
WORKDIR /diaphani
ENTRYPOINT ["/usr/local/bin/diaphani-entrypoint"]
