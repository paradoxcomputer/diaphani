#!/usr/bin/env bash
# diaphani-clientauth.sh — generate a v3 onion client-authorization keypair.
#
# The Logos node API has NO server-side auth, so v3 onion client authorization is
# the only thing that stops any Tor user who learns the .onion from calling every
# endpoint. Run this on the NODE side: it installs the client's PUBLIC key in the
# onion's authorized_clients/ (so only key-holders can reach the service) and
# prints the matching PRIVATE key to hand to that client.
#
# Server side (here): authorized_clients/<name>.auth  =  descriptor:x25519:<PUB>
# Client side (them):  <ClientOnionAuthDir>/<name>.auth_private
#                      = <onion-without-.onion>:descriptor:x25519:<PRIV>
set -euo pipefail
umask 077

NAME=${1:-${NAME:-diaphani}}
ONION=${2:-${ONION:-}}                       # the .onion hostname (for the client file line)
# Persistent store for authorized client PUBLIC keys (not secret); the CLI copies
# these into the live tmpfs HiddenServiceDir on every `up`.
AUTHDIR=${AUTHDIR:-$HOME/.diaphani/onion_authorized_clients}
# Optional: also drop straight into a live HiddenServiceDir.
HSDIR=${HSDIR:-}

command -v openssl >/dev/null || { echo "need openssl" >&2; exit 1; }
command -v base32  >/dev/null || { echo "need base32 (coreutils)" >&2; exit 1; }

# Keep the X25519 PRIVATE-key temp file off persistent disk: prefer /run (tmpfs) over
# $TMPDIR//tmp (persistent on most distros, so a plain `rm` leaves it in freed blocks),
# and `shred` it before removal. The trap shreds-then-removes on any exit path.
tmp=$(mktemp -d -p /run 2>/dev/null || mktemp -d)
trap 'find "$tmp" -type f -exec shred -fu {} + 2>/dev/null; rm -rf "$tmp"' EXIT
openssl genpkey -algorithm X25519 -out "$tmp/k.pem" 2>/dev/null
# x25519 raw keys are the last 32 bytes of the DER (fixed-size headers); Tor wants
# RFC4648 base32, uppercase, no '=' padding (52 chars).
PRIV=$(openssl pkey -in "$tmp/k.pem"          -outform DER 2>/dev/null | tail -c 32 | base32 | tr -d '=')
PUB=$( openssl pkey -in "$tmp/k.pem" -pubout  -outform DER 2>/dev/null | tail -c 32 | base32 | tr -d '=')

mkdir -p "$AUTHDIR"
printf 'descriptor:x25519:%s\n' "$PUB" > "$AUTHDIR/$NAME.auth"
echo "[diaphani] authorized client '$NAME' (public key) -> $AUTHDIR/$NAME.auth"

if [ -n "$HSDIR" ]; then
  mkdir -p "$HSDIR/authorized_clients"
  cp -f "$AUTHDIR/$NAME.auth" "$HSDIR/authorized_clients/$NAME.auth"
  chmod 700 "$HSDIR/authorized_clients"; chmod 600 "$HSDIR/authorized_clients/$NAME.auth"
  echo "[diaphani] installed into live HiddenServiceDir $HSDIR/authorized_clients/"
fi

ONION_BARE=${ONION%.onion}
echo
echo "=== give this PRIVATE key to the client (keep it secret) ==="
if [ -n "$ONION_BARE" ]; then
  echo "${ONION_BARE}:descriptor:x25519:${PRIV}"
  echo "→ save as <ClientOnionAuthDir>/${NAME}.auth_private on the client, then set"
  echo "  'ClientOnionAuthDir <dir>' in the client's torrc (or pass to arti's keystore)."
else
  echo "descriptor:x25519:${PRIV}    (prefix with '<onion-without-.onion>:' on the client)"
  echo "→ re-run with the .onion as arg 2 to emit the ready-to-save client line."
fi
