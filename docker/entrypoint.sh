#!/bin/bash
# Diaphani container entrypoint — self-contained bring-up + supervisor.
#
# The container IS the netns. On start this: connects nym, pins the masked egress
# (node QUIC -> nym policy table -> nym tunnel -> peers), starts the node, and
# (optionally) publishes the node API as a v3 .onion via an in-container tor that is
# UID-routed to clearnet (the node's own egress stays forced through nym). Then it
# supervises and keeps the container alive. Idempotent + restart-safe.
set -uo pipefail

NYM_MODE=${NYM_MODE:-fast}                 # fast (2-hop WG) | anon (5-hop mixnet) — the mode to CONNECT in
GRADUATE=${GRADUATE:-}                      # if set (anon), switch to it once the node is Online (the fast-5h strategy)
SWARM_PORT=${SWARM_PORT:-3000}
API_PORT=${API_PORT:-8080}
ENABLE_ONION=${ENABLE_ONION:-1}
BOOTSTRAP_DNS=${BOOTSTRAP_DNS:-1.1.1.1}    # nym custom DNS — resolves via DoH (kill-switch-permitted)
# Logos bootstrap peer multiaddrs (space-separated). MUST listen on a nym-allowed udp
# port (50000-65535) so the node reaches them straight through the tunnel (no relay in between).
BOOTSTRAP_PEERS=${BOOTSTRAP_PEERS:-}
# Testnet GENESIS id (the chain-start timestamp). `logos-blockchain-node init` stamps a FRESH
# genesis (its own start time) -> a standalone one-node chain that CANNOT join the testnet (its
# blocks would be ParentMissing forever). Setting this aligns the generated config `prefix` to
# the testnet's so the node joins + syncs the REAL chain. Empty = keep init's fresh genesis
# (a private / standalone net).
GENESIS_PREFIX=${GENESIS_PREFIX:-}
SECRETS=${SECRETS:-/diaphani/secrets}
DATA=${DATA:-/diaphani/data}
ONION_DIR=${ONION_DIR:-/diaphani/onion}
LOG() { printf '[diaphani %s] %s\n' "$(date +%H:%M:%S 2>/dev/null || echo --:--:--)" "$*"; }
FATAL() { LOG "FATAL: $*"; exit 1; }

mkdir -p "$DATA" "$ONION_DIR/api"

# Harden /proc so a process's argv (/proc/<pid>/cmdline) is readable only by its own
# uid (and root). `nym-vpnc account set` below takes the 24-word mnemonic on argv (the
# CLI offers no stdin/file form), which would otherwise be world-readable in /proc and
# to `ps` for the call's lifetime. hidepid=2 closes that to any non-root co-process; the
# root-run supervisor (pgrep/pkill) is unaffected. Best-effort: a sandbox may deny it.
mount -o remount,hidepid=2 /proc 2>/dev/null || mount -o hidepid=2 -t proc proc /proc 2>/dev/null || true

# Disable IPv6 in THIS netns (best-effort; --privileged grants it). Every route + uid-route
# the bring-up installs is IPv4 (the node's QUIC pin, tor's clearnet table 200) and the node
# is v4-only — so a globally-routable v6 default from a v6-enabled Docker bridge would carry
# a node v6 QUIC packet (or a tor v6 circuit) out $WAN_IF from the operator's REAL v6, masked
# only by nym's flushable table. Kill the v6 stack at the source so that surface can't exist;
# the dual-stack blackhole fallback below is the firewall-layer backstop. Tolerant of a
# kernel with ipv6 already off (the sysctl is then absent — nothing to leak anyway).
for k in all default; do echo 1 > "/proc/sys/net/ipv6/conf/$k/disable_ipv6" 2>/dev/null || true; done

# NOTE on the container resolver: on the default Docker bridge /etc/resolv.conf is
# `nameserver 127.0.0.11` (Docker's embedded resolver), which forwards an unknown name to the
# host's upstream resolvers FROM THE HOST netns — OUTSIDE nym's tun, its kill-switch, and the
# blackhole. We deliberately do NOT rewrite resolv.conf to a dead address: nym's pre-tunnel
# account-sync + gateway/api resolution (before `nym-vpnc dns set` configures DoH, below) reads
# this file, so killing it would re-deadlock the nym handshake. Instead the leak is closed at the
# SOURCE: the node is given ZERO hostnames to resolve — every bootstrap peer is rejected unless it
# carries an /ip4|/ip6 literal (the CLI resolvePeers() AND the BOOTSTRAP_PEERS guard below both
# FATAL on /dns*), and the NTP target is rewritten to a literal IP. So the node's libc/.with_dns()
# resolver never issues an A/AAAA query, and the only thing that reads resolv.conf is nym's own
# entry-side control plane (which already sees the operator ip by design).

# ── 1) nym ─────────────────────────────────────────────────────────────────
# nym-vpnd's run-as-service mode talks to the system D-Bus — start it first.
mkdir -p /run/dbus && rm -f /run/dbus/pid 2>/dev/null
dbus-daemon --system --fork 2>/dev/null || service dbus start >/dev/null 2>&1 || true
LOG "starting nym-vpnd"
pkill -x nym-vpnd 2>/dev/null; sleep 1
nohup nym-vpnd -v run-as-service --disable-client-verification >/diaphani/nymd.log 2>&1 &
sleep 10
# log in once if the daemon holds no account (account persists in /diaphani/data via
# nym's state dir if mounted; otherwise per container life).
if nym-vpnc account get 2>&1 | grep -qiE 'no account|not (found|logged)|loggedout|logged.?out|none|error|missing'; then
  [ -f "$SECRETS/nym.txt" ] || FATAL "no $SECRETS/nym.txt and nym has no stored account — the tmpfs mnemonic is RAM-only and gone after a host reboot, so re-run \`diaphani up\` (re-supplies the passphrase and re-writes it)"
  PHRASE="$(tr -s '[:space:]' ' ' < "$SECRETS/nym.txt" | sed 's/^ //;s/ $//')"
  nym-vpnc account set "$PHRASE" >/dev/null 2>&1 || true; unset PHRASE
fi
# wait for the account to finish syncing before connecting (avoids the flap)
for _ in $(seq 1 45); do
  nym-vpnc account get 2>&1 | grep -qiE 'ReadyToConnect|Active|Registered' && break; sleep 4
done
LOG "nym account: $(nym-vpnc account get 2>&1 | grep -i 'account state' | head -1 | sed 's/.*: *//')"
set_nym_mode() {           # $1 = fast|anon  (takes effect on the next connect)
  case "$1" in
    fast) nym-vpnc tunnel set --two-hop on  >/dev/null 2>&1 || true ;;
    anon) nym-vpnc tunnel set --two-hop off >/dev/null 2>&1 || true ;;
  esac
}
set_nym_mode "$NYM_MODE"
nym-vpnc tunnel set --ipv6 off >/dev/null 2>&1 || true
# Custom DNS so nym's gateway resolution goes over a path its OWN pre-connect
# kill-switch permits (DoH/DoT to the resolver) instead of the system resolver over
# plain udp/53, which the kill-switch rejects — otherwise it deadlocks "resolving
# api addresses" forever. (Verified: this advances nym past resolution to the WG
# handshake.)
nym-vpnc dns set "$BOOTSTRAP_DNS" >/dev/null 2>&1 || true
nym-vpnc dns enable >/dev/null 2>&1 || true
LOG "nym custom DNS set to $BOOTSTRAP_DNS"

# Connect nym, retrying — Fast Mode can drop the first attempt, and the tun iface + policy
# table appear a moment AFTER 'Connected', so don't do discovery instantly. Factored into a
# function so graduation (fast → 5-hop) can re-run the exact same handshake later.
connect_nym() {            # sets NYM_TABLE, NYM_IF, NFT; returns 0 on a stable tunnel
  # Lift the catch-all blackhole (if present) for the duration of the handshake: nym's
  # PRE-TUNNEL control plane — gateway registration + DoH api resolution — is UNMARKED, so
  # while nym's own policy rule isn't up yet that traffic would fall through to the blackhole
  # (prio 32700 -> table 666) and be DROPPED, and nym could never (re)connect. Safe to lift
  # ONLY when no node is alive — connect_nym is meant to run with the node NOT started (initial
  # bring-up) or already confirmed DEAD (supervise / graduate re-handshake). Enforce that as a
  # runtime precondition (fail-closed), not just a caller convention: lifting the blackhole
  # while a node could emit QUIC would let it fall through to the clearnet main default and
  # egress the REAL ip. If a node is somehow still alive, refuse to lift / disconnect and bail.
  # install_blackhole re-asserts it after pin_egress, once the tunnel is back up.
  if pgrep -f logos-blockchain-node >/dev/null 2>&1; then
    LOG "FATAL: connect_nym called with a node still alive — refusing to lift the blackhole / disconnect nym (would expose the real ip)"
    return 1
  fi
  # Defense-in-depth, independent of the cmdline matcher above: the pgrep oracle is the sole
  # liveness gate for a teardown that removes BOTH backstops, and `pgrep -f logos-blockchain-node`
  # could in principle miss a node child re-exec'd to a different argv. So ALSO refuse to lift the
  # blackhole while ANYTHING still holds the swarm UDP port — only the node ever binds it, so a
  # stuck/mismatched node the pgrep oracle missed would still hold its QUIC socket there, and lifting
  # the backstops would let it fall through to the clearnet main default and egress the REAL ip.
  # `ss -uHan sport = :$SWARM_PORT` lists UDP sockets bound to the swarm port (any state, no header);
  # any output at all means a socket is still bound. Only enforce when ss is present (iproute2).
  if command -v ss >/dev/null 2>&1 && [ -n "$(ss -uHan "sport = :$SWARM_PORT" 2>/dev/null)" ]; then
    LOG "FATAL: connect_nym called with the swarm udp port $SWARM_PORT still bound (a node socket the pgrep oracle missed?) — refusing to lift the blackhole / disconnect nym (would expose the real ip)"
    return 1
  fi
  while ip    rule del priority "${DIA_BH_PRIO:-32700}" 2>/dev/null; do :; done
  while ip -6 rule del priority "${DIA_BH_PRIO:-32700}" 2>/dev/null; do :; done
  # Discover into LOCALS and only commit to the globals on a fully-established tunnel — a
  # failed reconnect must NOT blank the last-good NYM_IF/NYM_TABLE (the supervise loop +
  # pin_egress read them; empty values would feed `ip route ... dev '' table ''` garbage and
  # mask the dark state). On failure the previous good values are left intact.
  local t= i= nft=
  for attempt in 1 2 3 4 5; do
    nym-vpnc connect >/dev/null 2>&1 || true
    for _ in $(seq 1 50); do nym-vpnc status 2>&1 | head -1 | grep -qi Connected && break; sleep 3; done
    if nym-vpnc status 2>&1 | head -1 | grep -qi Connected; then
      for _ in $(seq 1 20); do  # wait for the tunnel to actually materialise
        i=$(ip route get 1.1.1.1 2>/dev/null | grep -oE 'dev [^ ]+' | head -1 | awk '{print $2}')
        # Discover nym's policy table by TYING it to the tun: pick the policy table whose
        # default route actually points at $i. NEVER trust `head -1` of all `lookup` lines —
        # on every reconnect tor's `lookup 200 prio 1000` and the blackhole's `lookup 666
        # prio 32700` are already installed, and `ip rule` sorts by ascending priority, so a
        # bare head-pick could latch onto 200 (clobbering tor's clearnet table on pin) or 666
        # (overwriting the fail-closed blackhole with a tun route). Exclude local/main/default
        # (253/254/255) AND Diaphani/tor-owned tables (200, $DIA_BH_TABLE), then keep only a
        # table whose `default` routes out $i. This binds table↔tun, so a mis-sorted rule
        # cannot select the wrong table.
        t=
        case "$i" in
          tun*)
            for tbl in $(ip rule 2>/dev/null | grep -oE 'lookup [0-9]+' | awk '{print $2}' \
                         | grep -vE "^(253|254|255|200|${DIA_BH_TABLE:-666})$"); do
              if ip route show table "$tbl" 2>/dev/null | grep -qE "default .*dev $i"; then t=$tbl; break; fi
            done
            ;;
          *) i= ;;
        esac
        [ -n "$t" ] && [ -n "$i" ] && break
        sleep 1
      done
      [ -n "$t" ] && [ -n "$i" ] && break
    fi
    LOG "nym connect attempt $attempt incomplete (status='$(nym-vpnc status 2>&1 | head -1)' table=$t if=$i) — retrying"
    nym-vpnc disconnect >/dev/null 2>&1 || true; sleep 4
  done
  nft=$(nft list tables 2>/dev/null | grep -i nym | head -1 | awk '{print $2, $3}')
  [ -n "$t" ] && [ -n "$i" ] && [ -n "$nft" ] || return 1
  # Belt-and-suspenders: refuse to commit a table that does NOT carry a default via the tun.
  # The discovery loop already binds table↔tun, but re-prove it here so a mis-latched table
  # (e.g. tor's 200 or the blackhole's 666) can never be pinned by pin_egress — fail-closed.
  ip route show table "$t" 2>/dev/null | grep -qE "default .*dev $i" \
    || { LOG "FATAL: discovered nym table $t has no default via $i — refusing to pin (would mis-route)"; return 1; }
  # Assert the family is the dual-stack `inet nym` we depend on. Our v6 posture relies on
  # nym's `inet` (v4+v6) policy DROP covering IPv6 too; a v4-only `ip nym` (or a split
  # `ip nym`/`ip6 nym`) would silently leave the other family with no kill-switch. Refuse
  # to come up rather than route a family we can't prove is dropped (fail-closed).
  case "$nft" in
    'inet nym') ;;
    *) LOG "FATAL: nym kill-switch table is '$nft', not 'inet nym' — v6 coverage unverified, refusing to start"; return 1 ;;
  esac
  NYM_TABLE=$t; NYM_IF=$i; NFT=$nft
}
NYM_TABLE=; NYM_IF=; NFT=    # last-good tunnel coords (connect_nym only overwrites on success)
connect_nym || FATAL "nym did not establish a stable tunnel (status='$(nym-vpnc status 2>&1 | head -1)' table=$NYM_TABLE if=$NYM_IF nft=$NFT)"
LOG "nym: $(nym-vpnc status 2>&1 | head -1)  [if=$NYM_IF table=$NYM_TABLE]"
# Discover the container's WAN iface + gateway from the default route (NOT hardcoded
# eth0 — custom Docker networks name it differently). nym uses policy routing, so the
# main default still points at the docker bridge here.
WAN_IF=$(ip route show default 2>/dev/null | awk '/default/{print $5; exit}')
GW=$(ip route show default 2>/dev/null | awk '/default/{print $3; exit}')
[ -n "$WAN_IF" ] && [ -n "$GW" ] || FATAL "no usable default route — can't find the container's WAN gateway (custom Docker network? run on the default bridge)"
ip route replace default via "$GW" dev "$WAN_IF"    # keep main default (nym control-plane)
LOG "nym_table=$NYM_TABLE nym_if=$NYM_IF wan=$WAN_IF gw=$GW"

# ── 1b) standalone fail-closed fallback (Diaphani-OWNED, nym never flushes it) ─
# nym's `inet nym` policy DROP is the primary kill-switch, but nym FLUSHES + rebuilds it
# (and its policy table + rule) across a disconnect/graduate/flap — leaving a window where
# the node's QUIC, finding nym's policy rule gone, falls through the MAIN table's clearnet
# default ($GW dev $WAN_IF, set above + never reverted) and egresses $WAN_IF from the REAL
# ip. Close that window independently of nym: a dedicated blackhole table + a low-priority
# `ip rule` that catches anything which misses nym's (higher-priority) policy rule. It sits
# ABOVE the main-table lookup (so node fall-through is dropped, not routed clearnet) but
# BELOW tor's uid rule (1000) and nym's own fwmark/policy rules (so tor + nym's WG underlay
# still escape first). Route-layer + a fixed owned table, so nym's nft/rule churn never
# wipes it. Dual-stack: install for v4 AND v6 so a v6 fall-through is dropped too.
DIA_BH_TABLE=666           # dedicated blackhole table (no other user)
DIA_BH_PRIO=32700          # < main (32766), > tor uid (1000) + nym policy rules
DIA_WG_FWMARK=0x14d        # nym's WG underlay mark (DECISIONS.md §5) — must NOT be blackholed
# Is the blackhole's catch-all rule present AT ITS EXPECTED PRIORITY? `ip rule list` prints
# `<prio>:\tfrom all lookup <table>`, so anchor on BOTH so a stray same-table rule at another
# priority can't masquerade as the real backstop. $1 = "" (v4) | "-6".
blackhole_present() {
  ip $1 rule list 2>/dev/null | grep -qE "^${DIA_BH_PRIO}:[[:space:]].*lookup ${DIA_BH_TABLE}\b"
}
install_blackhole() {
  ip    route replace blackhole default table "$DIA_BH_TABLE" 2>/dev/null || true
  ip -6 route replace blackhole default table "$DIA_BH_TABLE" 2>/dev/null || true
  # Exempt nym's marked WG underlay (incl. the reconnect handshake) one priority ABOVE the
  # blackhole, sending it to main — so even if nym's own fwmark rule were ordered after ours
  # we never strand nym's control plane. The node's QUIC is UNMARKED, so this never opens it.
  ip    rule list 2>/dev/null | grep -qE "^$((DIA_BH_PRIO-1)):[[:space:]].*fwmark $DIA_WG_FWMARK lookup main" \
    || ip    rule add from all fwmark "$DIA_WG_FWMARK" lookup main priority "$((DIA_BH_PRIO-1))" 2>/dev/null || true
  ip -6 rule list 2>/dev/null | grep -qE "^$((DIA_BH_PRIO-1)):[[:space:]].*fwmark $DIA_WG_FWMARK lookup main" \
    || ip -6 rule add from all fwmark "$DIA_WG_FWMARK" lookup main priority "$((DIA_BH_PRIO-1))" 2>/dev/null || true
  # Add the catch-all blackhole rule at EXACTLY DIA_BH_PRIO. The idempotency guard anchors on
  # the priority too, so a pre-existing `lookup 666` at a DIFFERENT priority does not suppress
  # the correctly-prioritised add (which would leave the backstop at an ineffective priority).
  blackhole_present ''   || ip    rule add from all lookup "$DIA_BH_TABLE" priority "$DIA_BH_PRIO" 2>/dev/null || true
  blackhole_present '-6' || ip -6 rule add from all lookup "$DIA_BH_TABLE" priority "$DIA_BH_PRIO" 2>/dev/null || true
}
install_blackhole
# Fail-LOUD: the blackhole is the nym-INDEPENDENT fail-closed backstop, so a silent add-failure
# must abort bring-up — not be logged as success. Verify the catch-all rule actually landed at
# its priority for BOTH families (a v6 miss would leak a v6 fall-through). v6 is best-effort only
# when the v6 stack was disabled above (no v6 rules possible — and nothing to leak), so require
# v6 only while ip -6 rules are usable.
blackhole_present '' || FATAL "blackhole catch-all rule (prio $DIA_BH_PRIO lookup $DIA_BH_TABLE) did not install — refusing to start without the nym-independent fail-closed backstop"
# Require the v6 backstop too, but ONLY when the kernel actually has a usable IPv6 rule
# subsystem (a kernel built without IPv6 makes `ip -6 rule list` fail — then there is no v6
# routing surface and so no v6 fall-through to leak; a missing v6 rule is harmless). When the
# subsystem IS present, a missing v6 blackhole is a real unprotected v6 fall-through — abort.
if ip -6 rule list >/dev/null 2>&1; then
  blackhole_present '-6' || FATAL "IPv6 blackhole catch-all rule (prio $DIA_BH_PRIO lookup $DIA_BH_TABLE) did not install — refusing to start with an unprotected v6 fall-through"
fi
LOG "fail-closed blackhole fallback installed + verified (table $DIA_BH_TABLE prio $DIA_BH_PRIO, v4+v6)"

# ── 2) node egress: straight through the nym tunnel ────────────────────────
# nym's exit blocks most ports but allows udp 50000-65535, where the Logos peers now
# listen — so the node's QUIC goes node -> nym tun -> exit -> peers, masked, with
# nothing in between. nym's kill-switch output policy is `drop` and does NOT permit
# its own tun by default, so open it explicitly (both directions: egress + QUIC replies).
open_nym_egress() {
  nft list chain $NFT output 2>/dev/null | grep -qE "oif \"$NYM_IF\" accept" || nft insert rule $NFT output oif "$NYM_IF" accept 2>/dev/null || true
  nft list chain $NFT input  2>/dev/null | grep -qE "iif \"$NYM_IF\" accept" || nft insert rule $NFT input iif "$NYM_IF" accept 2>/dev/null || true
}
# Open nym's kill-switch for the tunnel + pin the node's default route to it. Re-run after
# every (re)connect — a graduation or a flap rebuilds nym's table + policy default, wiping these.
pin_egress() {
  open_nym_egress
  ip route replace default dev "$NYM_IF" table "$NYM_TABLE"
}
# Re-pin the tunnel AND re-assert the nym-independent blackhole as one inseparable step. Every
# connect_nym LIFTS the blackhole (so its pre-tunnel control plane can reach the gateways); a
# caller that re-pins egress but forgets to re-seal would restart the node with the backstop
# still down — a second nym flap in that gap leaks the real ip. Folding the re-seal into the
# re-pin makes it impossible to forget on any re-handshake path.
pin_and_seal() {
  pin_egress
  install_blackhole
}
pin_egress
LOG "egress check (1.1.1.1 -> $(ip route get 1.1.1.1 2>/dev/null | head -1))"

# node config (generate once, persisted in $DATA)
CONF="$DATA/user_config.yaml"
if [ ! -f "$CONF" ]; then
  [ -n "$BOOTSTRAP_PEERS" ] || FATAL "set BOOTSTRAP_PEERS to the testnet peer multiaddr(s) on a nym-allowed udp port (50000-65535)"
  # Mirror the CLI's literal-peer guard for the direct-env path (a hand-run `docker run`
  # sets BOOTSTRAP_PEERS without going through the JS validator). A /dns* (hostname) peer
  # would make the node's libp2p `.with_dns()` resolver issue a libc lookup at dial time —
  # to Docker's 127.0.0.11, forwarded upstream from the HOST netns, OUTSIDE nym's tun, its
  # kill-switch, and the blackhole — leaking a DNS query for the peer hostname from the REAL
  # ip. Only /ip4|/ip6 literals reach the peer straight through the tunnel with no lookup.
  for ma in $BOOTSTRAP_PEERS; do
    case "$ma" in
      */ip4/*|*/ip6/*) ;;
      *) FATAL "bootstrap peer '$ma' is not an /ip4|/ip6 literal — a /dns* hostname would leak a clearnet DNS lookup of the real ip outside nym. Use a literal-IP multiaddr." ;;
    esac
  done
  # Strip the trailing /p2p/<peer-id> from each multiaddr before `init -p`. The 0.1.2 node
  # wants `initial_peers` WITHOUT the peer-id (per the Logos devs), and passing the bare
  # /ip4/.../quic-v1 also leaves the cryptarchia bootstrap `ibd` list empty — exactly the
  # "ibd empty, only initial_peers set" config the devs confirmed works for 0.1.2. (Keeping
  # the /p2p suffix would both mis-format initial_peers AND populate ibd with the peer-id.)
  PEERS=""; for ma in $BOOTSTRAP_PEERS; do PEERS="$PEERS -p ${ma%%/p2p/*}"; done
  # Bind the API to loopback ONLY: in-container tor reaches it on 127.0.0.1
  # (HiddenServicePort below) and the CLI health check uses 127.0.0.1 too, so nothing
  # breaks — but a 0.0.0.0 bind would let any co-located container on the Docker bridge
  # reach the unauthenticated API directly, bypassing the onion + its client-auth.
  #
  # --external-address switches libp2p NAT from `traversal` to `static`, which DISABLES the
  # active NAT machinery: no UPnP / NAT-PMP / PCP gateway port-mapping, no gateway_monitor, and
  # no AutoNAT *client* dial-out probes. (The AutoNAT *server* is still built — but its dial-backs
  # ride the nym tun like all other egress, so they are masked, not a leak.) Our node is
  # dial-out-only behind nym, so it needs none of that, and a probe to the gateway is pointless
  # (the kill-switch drops it). Defense-in-depth: even though the kill-switch already drops these
  # probes, the node now never even tries the client ones.
  #
  # CAVEAT — the RFC-5737 doc address (203.0.113.0/24) below is NOT a durable anti-leak: libp2p
  # static-NAT OVERWRITES static_listen_addr with each real per-interface NewListenAddr (the node
  # listens on 0.0.0.0), and identify's all_addresses() always includes the confirmed external
  # addr regardless of hide_listen_addrs — so the node DOES advertise its real per-interface
  # listen IP. The ONLY reason that is not a deanonymizing address is the bridge topology: this
  # container runs on the default Docker bridge (docker.js: no --network host), so its netns holds
  # only RFC-1918 bridge + nym-tun IPs — the operator's real public IP is structurally absent.
  # DO NOT run this container with `--network host`: that would put the real public IP in the
  # netns and turn this advertisement into a direct real-IP leak.
  /opt/logos/logos-blockchain-node init $PEERS --net-port "$SWARM_PORT" --http-addr 127.0.0.1:"$API_PORT" \
    --external-address "/ip4/203.0.113.1/udp/$SWARM_PORT/quic-v1" -o "$CONF" \
    || FATAL "node init failed"
  sed -i 's#server: pool.ntp.org:123#server: 162.159.200.123:123#' "$CONF" 2>/dev/null || true
  # FAIL-LOUD (mirrors the GENESIS_PREFIX check below). The rewrite is what gives the node ZERO
  # hostnames to resolve (see the SOURCE note at the top): the NTP target must be a literal IP, or
  # the node's libc resolver issues an A/AAAA lookup of pool.ntp.org via Docker's 127.0.0.11 — which
  # forwards from the HOST netns, OUTSIDE nym's tun/kill-switch/blackhole, leaking the real IP to a
  # network observer. A future config-format drift could make the sed silently no-op; refuse to
  # start unless the literal IP is in AND the hostname is out, rather than fail open.
  { grep -q 'server: 162.159.200.123:123' "$CONF" && ! grep -q 'pool.ntp.org' "$CONF"; } \
    || FATAL "NTP rewrite did not land in $CONF — node would resolve a hostname (real-IP DNS leak outside nym)"
  # Join the testnet GENESIS. `init` stamped a FRESH genesis (its own start time) -> a standalone
  # one-node chain whose blocks the testnet peers can't parent. Align the config `prefix` to the
  # testnet's chain-start id so the node syncs the REAL chain. Empty GENESIS_PREFIX keeps the
  # fresh init genesis (a standalone net). VERIFIED: a fresh node with only the prefix aligned
  # joins + syncs from height 0.
  if [ -n "$GENESIS_PREFIX" ]; then
    sed -i "s/prefix: '[0-9]*'/prefix: '$GENESIS_PREFIX'/" "$CONF" 2>/dev/null || true
    grep -q "prefix: '$GENESIS_PREFIX'" "$CONF" || FATAL "could not set genesis prefix $GENESIS_PREFIX in $CONF"
    LOG "joined testnet genesis (prefix $GENESIS_PREFIX)"
  else
    LOG "WARNING: no GENESIS_PREFIX set — node will run a STANDALONE fresh genesis, NOT joining any testnet"
  fi
  LOG "generated node config at $CONF (NAT traversal/UPnP/AutoNAT disabled — dial-out-only)"
else
  # An existing config (persisted in the dia-data volume) is reused as-is — so a
  # changed BOOTSTRAP_PEERS is NOT applied. Say so, or an operator who edits peers
  # and re-ups is silently no-op'd. (Wipe dia-data to regenerate with new peers.)
  LOG "reusing existing node config at $CONF — BOOTSTRAP_PEERS is ignored (wipe the dia-data volume to regenerate)"
fi
start_node() {
  pkill -f logos-blockchain-node 2>/dev/null; sleep 1
  ( cd "$DATA" && LOGOS_BLOCKCHAIN_CIRCUITS=/opt/logos/circuits LOG_LEVEL=info \
    nohup /opt/logos/logos-blockchain-node "$CONF" >/diaphani/node.log 2>&1 & )
}
start_node
sleep 8
pgrep -f logos-blockchain-node >/dev/null && LOG "node: running" || { LOG "node failed:"; tail -8 /diaphani/node.log; }

# ── 3) .onion (in-container tor, UID-routed to clearnet; node API on loopback) ─
if [ "$ENABLE_ONION" = "1" ]; then
  TUID=$(id -u debian-tor 2>/dev/null || echo '')
  [ -n "$TUID" ] && [ "$TUID" != "0" ] || FATAL "the debian-tor user is missing — onion clearnet routing would fall back to root (uid 0) and unmask it"
  ip route replace default via "$GW" dev "$WAN_IF" table 200 2>/dev/null || true
  ip rule add uidrange "$TUID-$TUID" lookup 200 priority 1000 2>/dev/null || true
  # allow tor's clearnet OUT (insert BEFORE nym's reject) + its circuit returns IN
  open_tor() {
    nft list chain $NFT output 2>/dev/null | grep -q "skuid $TUID accept" || nft insert rule $NFT output meta skuid "$TUID" accept 2>/dev/null || true
    nft list chain $NFT input  2>/dev/null | grep -q "iif \"$WAN_IF\" ct state established" || nft insert rule $NFT input iif "$WAN_IF" ct state established,related accept 2>/dev/null || true
  }
  open_tor
  mkdir -p /var/lib/tor-dia/api
  cp -f "$ONION_DIR"/api/* /var/lib/tor-dia/api/ 2>/dev/null || true
  # v3 client-auth is the ONLY access control on the unauthenticated node API. The CLI
  # bind-mounts the operator's pubkeys read-only at /diaphani/onion_authorized_clients.
  # Install them so tor enforces auth; if none are present, warn LOUDLY — the onion would
  # otherwise be reachable by anyone with the address.
  AUTH_SRC=/diaphani/onion_authorized_clients
  if ls "$AUTH_SRC"/*.auth >/dev/null 2>&1; then
    mkdir -p /var/lib/tor-dia/api/authorized_clients
    cp -f "$AUTH_SRC"/*.auth /var/lib/tor-dia/api/authorized_clients/ 2>/dev/null || true
    chmod 600 /var/lib/tor-dia/api/authorized_clients/*.auth 2>/dev/null || true
    LOG "onion client-auth installed ($(ls -1 /var/lib/tor-dia/api/authorized_clients/*.auth 2>/dev/null | wc -l) client(s))"
  else
    LOG "WARNING: .onion has NO client-auth — anyone with the address could call the node API. Run \`diaphani clientauth <name>\` then re-up."
  fi
  chown -R debian-tor:debian-tor /var/lib/tor-dia 2>/dev/null || true
  chmod 700 /var/lib/tor-dia /var/lib/tor-dia/api 2>/dev/null || true
  [ -d /var/lib/tor-dia/api/authorized_clients ] && chmod 700 /var/lib/tor-dia/api/authorized_clients 2>/dev/null || true
  cat > /etc/tor/dia-torrc <<EOF
DataDirectory /var/lib/tor-dia
SocksPort 0
RunAsDaemon 1
User debian-tor
Log notice file /var/lib/tor-dia/notice.log
HiddenServiceDir /var/lib/tor-dia/api
HiddenServiceVersion 3
HiddenServicePort 80 127.0.0.1:${API_PORT}
EOF
  pkill -x tor 2>/dev/null; sleep 1
  tor -f /etc/tor/dia-torrc >/dev/null 2>&1
  for _ in $(seq 1 30); do grep -qi 'Bootstrapped 100' /var/lib/tor-dia/notice.log 2>/dev/null && break; sleep 5; done
  # persist the (possibly freshly-generated) onion keys back to the volume. Copy ONLY
  # the key/hostname files (NOT the authorized_clients/ subdir — that is re-supplied
  # from the host bind-mount on each start, and a flat `*` would fail on the subdir and
  # spuriously trip the warning). If this FAILS (volume full/perms) the address is lost
  # + regenerated next start — warn loudly so clients aren't silently broken.
  if ! cp -f /var/lib/tor-dia/api/hs_ed25519_secret_key /var/lib/tor-dia/api/hs_ed25519_public_key /var/lib/tor-dia/api/hostname "$ONION_DIR/api/" 2>/dev/null; then
    LOG "WARNING: could not persist the .onion key back to the dia-onion volume — the address may CHANGE on the next start (re-distribute it, or fix the volume)"
  fi
  ONION=$(cat /var/lib/tor-dia/api/hostname 2>/dev/null)
  LOG "tor: $(grep -oiE 'Bootstrapped [0-9]+%' /var/lib/tor-dia/notice.log 2>/dev/null | tail -1) | onion: $ONION"
fi

# ── 4) graduate (fast → 5-hop): once the node is synced, re-handshake nym on the mixnet ─
need_graduate=0
{ [ -n "$GRADUATE" ] && [ "$GRADUATE" != "$NYM_MODE" ]; } && need_graduate=1
[ "$need_graduate" = 1 ] && LOG "will graduate to the 5-hop mixnet once the node is genuinely synced (Online + peers + real height)"

node_mode() {   # the node's reported sync mode (Online / Bootstrapping / …), or empty
  curl -s --max-time 5 "http://127.0.0.1:$API_PORT/cryptarchia/info" 2>/dev/null \
    | grep -oE '"mode" *: *"[^"]+"' | head -1 | grep -oE '"[^"]+"$' | tr -d '"'
}
# Whether the node is GENUINELY caught up to the network tip — the gate for graduating to the
# 5-hop mixnet. mode alone is NOT enough: a node with ZERO peers and an empty DB still reports
# "Online" (nothing tells it there are higher blocks), so graduating on mode would switch a
# still-empty node onto the high-latency mixnet, where its 5s QUIC peer handshakes can never
# complete — trapping it at height 0 with no peers. Require Online AND >=1 connected peer AND a
# past-genesis height, so only a node actually following a real chain graduates.
node_synced() {
  [ "$(node_mode)" = "Online" ] || return 1
  local h p
  h=$(curl -s --max-time 5 "http://127.0.0.1:$API_PORT/cryptarchia/info" 2>/dev/null \
    | grep -oE '"height" *: *[0-9]+' | grep -oE '[0-9]+$')
  p=$(curl -s --max-time 5 "http://127.0.0.1:$API_PORT/network/info" 2>/dev/null \
    | grep -oE '"n_peers" *: *[0-9]+' | grep -oE '[0-9]+$')
  [ "${p:-0}" -ge 1 ] && [ "${h:-0}" -gt 0 ]
}
# Kill the node and CONFIRM it is provably gone before any nym re-handshake: SIGTERM, wait,
# SIGKILL, wait, then prove no pid remains. Returns 0 only when the node is confirmed dead;
# non-zero if it still will not die (D-state on disk I/O, or a child whose cmdline didn't
# match pkill -f). NO caller may run connect_nym (which lifts the blackhole + disconnects nym,
# tearing the kill-switch down) while this returns non-zero — a live node would then egress the
# REAL ip through the clearnet main default. The single source of the kill-confirm sequence so
# every re-handshake path (graduate + supervise) is structurally symmetric.
kill_node_confirmed() {
  pkill -f logos-blockchain-node 2>/dev/null
  for _ in $(seq 1 20); do pgrep -f logos-blockchain-node >/dev/null || break; sleep 1; done
  pkill -KILL -f logos-blockchain-node 2>/dev/null
  for _ in $(seq 1 15); do pgrep -f logos-blockchain-node >/dev/null || break; sleep 1; done
  ! pgrep -f logos-blockchain-node >/dev/null
}
graduate() {
  LOG "node synced — graduating nym to the 5-hop mixnet"
  # Kill the node FIRST and confirm it is gone, so no node packet can egress while nym tears
  # down + rebuilds its tunnel + kill-switch table during the re-handshake (no clearnet leak).
  # If the node still will not die, DON'T disconnect nym: tearing the tunnel + kill-switch down
  # under a live egress source is the leak window. Abort, keeping the current masked tunnel.
  if ! kill_node_confirmed; then
    LOG "WARNING: node will not die — ABORTING graduation, staying on the current masked tunnel"
    return 0
  fi
  set_nym_mode "$GRADUATE"
  nym-vpnc disconnect >/dev/null 2>&1 || true; sleep 4
  # Restart the node ONLY after a re-established + pinned tunnel. nym's disconnect flushed its
  # kill-switch table and the main default still points at the clearnet docker bridge, so
  # starting the node before connect_nym + pin_egress would egress unmasked — fail CLOSED.
  if connect_nym; then
    pin_and_seal      # re-pin the tunnel AND re-assert the blackhole BEFORE the node restarts
    [ "$ENABLE_ONION" = "1" ] && open_tor
    start_node
    LOG "graduated — now on the 5-hop mixnet  [if=$NYM_IF table=$NYM_TABLE]"
  else
    # 5-hop didn't come up — recover on Fast Mode so the node isn't left dark.
    LOG "WARNING: 5-hop reconnect failed — restoring Fast Mode"
    set_nym_mode fast
    if connect_nym; then
      pin_and_seal    # re-pin the tunnel AND re-assert the blackhole BEFORE the node restarts
      [ "$ENABLE_ONION" = "1" ] && open_tor
      start_node
      LOG "recovered on Fast Mode  [if=$NYM_IF table=$NYM_TABLE]"
    else
      # Neither came up — leave the node DOWN (no kill-switch, clearnet default). The
      # supervise loop re-handshakes nym before it will start the node again.
      LOG "FATAL-SOFT: nym did not reconnect on fast either — leaving node DOWN (fail-closed); supervise loop will retry"
    fi
  fi
}

LOG "=== Diaphani up. Supervising (node + nym). ==="
# ── 5) supervise: keep the container alive; restart the node if it dies ─────
# Poll FAST (5s, not 30s) and check tunnel health at the TOP of the loop, BEFORE any sleep:
# on a spontaneous mid-life nym flap the node must die the instant the tun is gone, so no
# node QUIC can fall through to the main clearnet default while nym's own DROP table is
# mid-rebuild. The standalone blackhole fallback (above) is the backstop for the sub-poll
# window; this kill-first check minimises how long the node is even alive to probe it.
while true; do
  # Re-assert the owned blackhole fallback first — it must hold across every tick no matter
  # what nym churns (it is route-layer + an owned table, so nym never flushes it, but a
  # belt-and-suspenders re-add costs nothing and self-heals a manual `ip rule flush`).
  install_blackhole 2>/dev/null
  # Ensure the masked tunnel is present BEFORE restarting/re-pinning the node. A failed
  # graduate-recover (or a mid-life nym flap) can leave NYM_IF/NYM_TABLE empty or the tun
  # gone; KILL THE NODE FIRST (no node packet may outlive the tunnel), then re-handshake nym
  # so we never feed `ip route ... dev '' table ''` garbage or run the node with no
  # kill-switch. If it still won't come up, leave the node DOWN (closed).
  if [ -z "$NYM_IF" ] || [ -z "$NYM_TABLE" ] || ! ip link show "$NYM_IF" >/dev/null 2>&1; then
    LOG "masked tunnel lost (if='$NYM_IF' table='$NYM_TABLE') — killing node, re-handshaking nym"
    # CONFIRM the node is dead before re-handshaking nym. connect_nym lifts the blackhole and
    # disconnects nym (tearing the kill-switch down); a bare async SIGTERM leaves the node alive
    # and draining QUIC, which would fall through to the clearnet main default and egress the
    # REAL ip during the lift. If the node won't die, do NOT touch nym/the blackhole — keep the
    # current (still-pinned) masked state and retry next tick (fail-closed), like graduate().
    if ! kill_node_confirmed; then
      LOG "node will not die — NOT re-handshaking nym (keeping current masked state, fail-closed)"; sleep 5; continue
    fi
    connect_nym && pin_and_seal || { LOG "nym still down — keeping node DOWN (fail-closed)"; sleep 5; continue; }
  fi
  # re-assert the masked egress — nym re-creates its table + policy default on each
  # reconnect, silently wiping our rules (which would drop the node off the tunnel).
  open_nym_egress 2>/dev/null
  ip route replace default dev "$NYM_IF" table "$NYM_TABLE" 2>/dev/null || true
  [ "$ENABLE_ONION" = "1" ] && open_tor 2>/dev/null
  pgrep -f logos-blockchain-node >/dev/null || { LOG "node died — restarting"; start_node; }
  # one-shot graduation: when the node is GENUINELY synced (Online + peers + a real height — not
  # the false "Online" a peerless empty node reports), switch to the 5-hop mixnet. If it fails,
  # graduate() recovers on Fast Mode and we don't re-flap.
  if [ "$need_graduate" = 1 ] && node_synced; then
    graduate
    need_graduate=0
  fi
  # Sleep at the BOTTOM (health is checked at the TOP next tick) and keep it SHORT so a
  # spontaneous nym flap is detected — and the node killed — in seconds, not up to ~30s.
  sleep 5
done
