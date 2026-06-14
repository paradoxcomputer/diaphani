//! diaphani-forward — bridge a local TCP port to a Diaphani `.onion` over Tor.
//!
//! This is how you plug an **unmodified** service into a hidden Logos node. A LEZ
//! sequencer reaches L1 via a plain `node_url` (e.g. `http://localhost:8081`); run
//! this forwarder and set that `node_url` to the local listen address — every
//! request the sequencer makes to L1 (reads *and* `POST /mempool/add/tx` writes)
//! then travels through Tor to the node's `.onion`, with no change to the sequencer.
//!
//! ```text
//! diaphani-forward --onion <addr>.onion --listen 127.0.0.1:8081
//! #   then in the sequencer config:  "node_url": "http://127.0.0.1:8081"
//! ```
//!
//! It's a raw TCP relay (not HTTP-aware), so request bodies, ndjson streams and
//! keep-alive all pass through unchanged. The onion provides the encryption; pair
//! it with onion client-auth so only key-holders can reach the node.

use std::time::Duration;

use clap::Parser;
use tokio::io::copy_bidirectional;
use tokio::net::{lookup_host, TcpListener};
use tokio::time::timeout;
use tokio_socks::tcp::Socks5Stream;

#[derive(Parser)]
#[command(
    name = "diaphani-forward",
    version,
    about = "Forward a local port to a Diaphani .onion over Tor"
)]
struct Cli {
    /// The node's v3 .onion address.
    #[arg(long, env = "DIAPHANI_ONION")]
    onion: String,

    /// Port on the onion to reach (the node API onion publishes :80).
    #[arg(long, default_value_t = 80)]
    onion_port: u16,

    /// Tor SOCKS5 proxy host:port (Tor Browser uses 127.0.0.1:9150).
    #[arg(long, env = "DIAPHANI_SOCKS", default_value = "127.0.0.1:9050")]
    socks: String,

    /// Local address to listen on — set the service's node_url to this.
    #[arg(long, default_value = "127.0.0.1:8081")]
    listen: String,

    /// Seconds to wait for the Tor SOCKS dial before giving up on a stuck circuit.
    #[arg(long, default_value_t = 30)]
    connect_timeout: u64,

    /// Permit binding --listen to a non-loopback address. The relay has NO auth of its
    /// own (the onion's client-auth is consumed by this single hop), so a wide bind
    /// hands any reachable host an authenticated pipe to the node API — opt in explicitly.
    #[arg(long)]
    allow_public_listen: bool,

    /// Permit a non-loopback --socks (DIAPHANI_SOCKS) proxy. With socks5h the proxy resolves
    /// AND dials the .onion, so an off-box/poisoned proxy carries every relayed read + signed-tx
    /// write AND learns which .onion you reach — linking the operator's real ip to the node.
    /// Refused by default (symmetric with --allow-public-listen); opt in only if you trust it.
    #[arg(long, env = "DIAPHANI_ALLOW_REMOTE_SOCKS")]
    allow_remote_socks: bool,
}

// Whether a `host:port` SOCKS endpoint points at the local machine (`localhost`, an IPv4
// loopback 127.0.0.0/8, or `::1`). A non-parseable / non-loopback host returns false so the
// caller can warn. Mirrors the SDK's is_loopback_socks — only used to flag a misconfigured
// DIAPHANI_SOCKS, never to route.
fn is_loopback_socks(host_port: &str) -> bool {
    use std::net::IpAddr;
    // Split off the port. Bracketed IPv6 (`[::1]:9050`) → strip the brackets; otherwise take
    // everything before the LAST colon (an unbracketed bare IPv6 has several and is ambiguous,
    // so only treat it as a host when it parses whole).
    let host = if let Some(rest) = host_port.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else if let Ok(ip) = host_port.parse::<IpAddr>() {
        return ip.is_loopback();
    } else {
        host_port.rsplit_once(':').map_or(host_port, |(h, _)| h)
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

// A v3 onion host is exactly 56 base32 chars + ".onion". Anything else is a
// clearnet host — relaying signed-tx traffic there via a Tor exit would silently
// break the onion's end-to-end encryption + client-auth trust boundary.
fn is_v3_onion(host: &str) -> bool {
    match host.strip_suffix(".onion") {
        Some(b) => {
            b.len() == 56
                && b.bytes()
                    .all(|c| c.is_ascii_lowercase() || (b'2'..=b'7').contains(&c))
        }
        None => false,
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let onion = cli
        .onion
        .trim()
        .trim_end_matches('/')
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .to_string();
    // Reject a still-embedded scheme (mirrors the SDK normalizer) so a partially-stripped
    // or non-http URL fails clearly here rather than tripping the .onion guard below.
    if onion.contains("://") {
        anyhow::bail!("--onion must be a bare onion host, not a URL (got {onion:?})");
    }
    // Fail closed: refuse a non-.onion target so a typo'd/hostile --onion (or
    // DIAPHANI_ONION) can't relay the service's traffic to a clearnet host.
    if !is_v3_onion(&onion) {
        anyhow::bail!(
            "--onion must be a v3 .onion address (got {onion:?}); diaphani-forward refuses to relay to a clearnet host"
        );
    }

    // Default to loopback-only: the relay has no auth of its own, so a non-loopback bind
    // would expose an authenticated pipe to the node API. Require an explicit opt-in.
    // RESOLVE the listen string ONCE here — a bare SocketAddr parse silently skips the guard
    // for a hostname (e.g. `mybox.lan:8081`) that bind() would then resolve to a public iface.
    // bind() the RESOLVED addresses below (not the raw string) so the checked set is exactly
    // the bound set — re-resolving the string at bind() is a TOCTOU: a hostname whose DNS flips
    // (all-loopback at check, public at bind) could otherwise bind a public iface past the guard.
    let listen_addrs: Vec<std::net::SocketAddr> = lookup_host(&cli.listen).await?.collect();
    if listen_addrs.is_empty() {
        anyhow::bail!("--listen {} resolved to no addresses", cli.listen);
    }
    if !cli.allow_public_listen {
        for addr in &listen_addrs {
            if !addr.ip().is_loopback() {
                anyhow::bail!(
                    "--listen {} resolves to non-loopback {}; the relay has no auth of its own, so binding beyond 127.0.0.1 exposes the node API. Pass --allow-public-listen to override.",
                    cli.listen,
                    addr.ip()
                );
            }
        }
    }

    // socks5h: the proxy resolves+dials the .onion, so a non-loopback --socks would route the
    // ENTIRE relayed L1 stream (reads AND signed-tx writes) AND the .onion resolution through
    // that host while the .onion guard still passes — linking the operator's real ip to the
    // node. Fail CLOSED by default (symmetric with --allow-public-listen above); an advanced
    // off-box setup must opt in via --allow-remote-socks (a missed stderr warning on an
    // unattended forwarder is not enough protection for the operator-ip<->node linkage).
    if !cli.allow_remote_socks && !is_loopback_socks(&cli.socks) {
        anyhow::bail!(
            "--socks {:?} (DIAPHANI_SOCKS) is not a loopback proxy; with socks5h it would route all \
             relayed node traffic and .onion resolution through that host (linking your real ip to \
             the node). Use a local Tor SOCKS (127.0.0.1:9050), or pass --allow-remote-socks if you \
             truly trust this off-box proxy.",
            cli.socks
        );
    }

    // Bind the RESOLVED address(es), not the raw string — closes the resolve-vs-bind TOCTOU.
    let listener = TcpListener::bind(listen_addrs.as_slice()).await?;
    eprintln!(
        "diaphani-forward: {} -> {}:{}  (via Tor SOCKS {})",
        cli.listen, onion, cli.onion_port, cli.socks
    );

    let dial_timeout = Duration::from_secs(cli.connect_timeout);
    loop {
        // A transient accept() error (EMFILE/ENFILE on fd exhaustion, ECONNABORTED) must
        // not tear down the relay — that would sever the service's only link to L1. Log
        // and back off briefly; keep the bind() above fatal (a real startup failure).
        let (mut client, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                eprintln!("accept failed: {e}");
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
        };
        let socks = cli.socks.clone();
        let onion = onion.clone();
        let port = cli.onion_port;
        tokio::spawn(async move {
            // socks5h: the proxy (Tor) resolves the .onion; we never DNS it ourselves.
            // Bound the dial so a stalled Tor circuit/rendezvous doesn't pin the socket
            // + task forever (copy_bidirectional then runs until either side closes).
            match timeout(
                dial_timeout,
                Socks5Stream::connect(socks.as_str(), (onion.as_str(), port)),
            )
            .await
            {
                Ok(Ok(mut upstream)) => {
                    if let Err(e) = copy_bidirectional(&mut client, &mut upstream).await {
                        eprintln!("relay {peer} closed: {e}");
                    }
                }
                Ok(Err(e)) => eprintln!("dial .onion failed for {peer}: {e}"),
                Err(_) => eprintln!(
                    "dial .onion timed out for {peer} after {}s",
                    dial_timeout.as_secs()
                ),
            }
        });
    }
}
