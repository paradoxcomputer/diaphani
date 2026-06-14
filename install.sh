#!/usr/bin/env sh
# Diaphani bootstrap — gets you from a bare Linux box to the `diaphani` command.
# It installs Node.js (if missing) + the diaphani CLI; the CLI then installs Docker
# and everything else itself. Run:
#
#   curl -fsSL https://raw.githubusercontent.com/paradoxcomputer/diaphani/main/install.sh | sh
#
# then:  diaphani setup  &&  diaphani up
#
# TRUST NOTE: this is a curl|sh installer (TOFU — trust-on-first-use over TLS, no
# checksum), and the apt branch below pipes the NodeSource setup script into `sudo bash`.
# Both run unverified remote code as root, gated only on TLS. This is the convenience
# path; the node/circuits/nym binaries are baked into the Docker image at build time and
# ARE sha256-pinned there (each `sha256sum -c`'d in docker/Dockerfile).
# To avoid the TOFU step, download this file, review it, then run it locally; and prefer
# your distro's `nodejs` package over the NodeSource pipe if your policy requires it.
set -eu

PKG="@paradoxcomputer/diaphani"
NODE_MAJOR=20

say()  { printf '\033[36m[diaphani]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[diaphani] %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if have sudo; then SUDO="sudo"; else die "need root or sudo to install Node.js / the CLI"; fi
fi

# 1) Node.js (>= 18). Install Node 20 LTS if missing or too old.
node_ok() { have node && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 18 ]; }
if node_ok; then
  say "Node.js $(node -v) present"
else
  say "installing Node.js ${NODE_MAJOR} LTS…"
  if have apt-get; then
    $SUDO apt-get update -qq
    $SUDO apt-get install -y ca-certificates curl gnupg
    # Download to a temp file and check curl's OWN exit status before running it as root:
    # `curl | bash` masks a TLS-truncated download (the pipeline takes bash's status, and
    # POSIX sh has no pipefail). Drop `-E` so an inherited proxy/env can't redirect it.
    ns_tmp=$(mktemp)
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o "$ns_tmp" \
      || { rm -f "$ns_tmp"; die "NodeSource setup script download failed (TLS error/truncated) — not running it"; }
    $SUDO bash "$ns_tmp"; rm -f "$ns_tmp"
    $SUDO apt-get install -y nodejs
  elif have dnf;    then $SUDO dnf install -y nodejs npm
  elif have pacman; then $SUDO pacman -Sy --noconfirm nodejs npm
  elif have apk;    then $SUDO apk add --no-cache nodejs npm
  else die "couldn't auto-install Node.js — install Node >= 18 (https://nodejs.org) and re-run."
  fi
  node_ok || die "Node.js install did not produce node >= 18 — install it manually."
  say "Node.js $(node -v) installed"
fi

# 2) the diaphani CLI (try without sudo first; fall back to sudo for a system npm prefix).
say "installing the diaphani CLI ($PKG)…"
if npm install -g "$PKG" >/dev/null 2>&1 || $SUDO npm install -g "$PKG" >/dev/null 2>&1; then
  say "installed $PKG"
else
  die "couldn't install $PKG from npm (not published yet?). Install from source instead:
    git clone https://github.com/paradoxcomputer/diaphani
    cd diaphani/cli && $SUDO npm install -g ."
fi

have diaphani || die "the 'diaphani' command isn't on PATH — open a new shell, or check your npm global bin dir."

printf '\n'
say "done. Next steps:"
printf '  diaphani setup            # nym phrase, bootstrap peers, anonymity strategy\n'
printf '  diaphani up               # installs Docker if needed + runs the masked node\n'
printf '  diaphani status --follow  # watch it sync\n'
