//! diaphani-explorer — a read-only Logos chain explorer that reaches a
//! Diaphani-fronted node over its Tor `.onion`.
//!
//! It's a reference consumer of `diaphani-client`: it pulls in the crate, dials
//! the node over a Tor SOCKS proxy, and uses only the read-only API. Nothing here
//! enables the `node-wallet` feature, so the node-wallet `transfer_funds` is compiled
//! out and it can never move funds — exactly the posture you want for an explorer/indexer.
//!
//! ```text
//! diaphani-explorer --onion <addr>.onion info
//! diaphani-explorer --onion <addr>.onion peers
//! diaphani-explorer --onion <addr>.onion blocks 100 200
//! diaphani-explorer --onion <addr>.onion watch --interval 10
//! ```

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use clap::{Parser, Subcommand};
use diaphani_client::{Client, CryptarchiaInfo};

#[derive(Parser)]
#[command(
    name = "diaphani-explorer",
    version,
    about = "Read-only Logos explorer over a Diaphani .onion"
)]
struct Cli {
    /// The node's v3 .onion address.
    #[arg(long, env = "DIAPHANI_ONION")]
    onion: String,

    /// Tor SOCKS5 proxy host:port (Tor Browser uses 127.0.0.1:9150).
    #[arg(long, env = "DIAPHANI_SOCKS", default_value = "127.0.0.1:9050")]
    socks: String,

    /// Per-request timeout in seconds (onion round-trips are slow).
    #[arg(long, default_value_t = 60)]
    timeout: u64,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Tip, height, and sync mode.
    Info,
    /// libp2p peers + listen addresses.
    Peers,
    /// Fetch blocks in a slot range.
    Blocks { from: u64, to: u64 },
    /// Follow the chain: poll info and report new blocks as the tip advances.
    Watch {
        /// Poll interval in seconds.
        #[arg(long, default_value_t = 10)]
        interval: u64,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    let node = Client::builder(cli.onion.as_str())
        .socks_proxy(cli.socks.as_str())
        .timeout(Duration::from_secs(cli.timeout))
        .build()?;

    match cli.cmd {
        Cmd::Info => print_info(&node.info().await?),
        Cmd::Peers => {
            let n = node.network_info().await?;
            println!(
                "peers: {}  connections: {}  pending: {}",
                n.n_peers, n.n_connections, n.n_pending_connections
            );
            if !n.peer_id.is_empty() {
                println!("peer_id: {}", n.peer_id);
            }
            for a in &n.listen_addresses {
                println!("  listen {a}");
            }
        }
        Cmd::Blocks { from, to } => {
            let blocks = node.blocks(from, to).await?;
            let count = blocks.as_array().map_or(0, |a| a.len());
            println!("blocks in slots {from}..={to}: {count}");
            println!("{}", serde_json::to_string_pretty(&blocks)?);
        }
        Cmd::Watch { interval } => watch(&node, interval).await,
    }
    Ok(())
}

fn print_info(i: &CryptarchiaInfo) {
    println!(
        "mode   {}{}",
        i.mode,
        if i.is_online() { "  (online)" } else { "" }
    );
    println!("height {}", i.height);
    println!("tip    {}", i.tip);
    println!("lib    {}", i.lib);
}

/// Poll the node and report each time the tip advances; fetch the new blocks in
/// the slot gap (the indexer-ish bit). Runs until interrupted.
async fn watch(node: &Client, interval: u64) {
    println!("watching the chain over the .onion (Ctrl-C to stop)…");
    let mut last_slot: u64 = 0;
    loop {
        match node.info().await {
            Ok(i) => {
                // Distinguish a missing/malformed slot (None) from a genuine slot 0:
                // coercing both to 0 would silently mask a node returning garbage.
                let slot = match i.slot.as_u64() {
                    Some(s) => s,
                    None => {
                        eprintln!(
                            "[{}] node reported no/!u64 slot ({}) — skipping",
                            unix_secs(),
                            i.slot
                        );
                        tokio::time::sleep(Duration::from_secs(interval)).await;
                        continue;
                    }
                };
                // A slot BELOW last_slot means the node rewound (reorg/restart). We don't
                // rewind last_slot (the gap blocks were already reported), but flag it so
                // the operator can tell a missed range from a quiet chain.
                if last_slot > 0 && slot < last_slot {
                    eprintln!(
                        "[{}] slot went backwards {last_slot} -> {slot} (possible reorg/restart)",
                        unix_secs()
                    );
                }
                if slot > last_slot {
                    print!(
                        "[{}] height {} slot {} mode {}",
                        unix_secs(),
                        i.height,
                        slot,
                        i.mode
                    );
                    if last_slot > 0 {
                        match node.blocks(last_slot + 1, slot).await {
                            Ok(b) => {
                                print!("  (+{} block(s))", b.as_array().map_or(0, |a| a.len()))
                            }
                            Err(e) => print!("  (block fetch failed: {e})"),
                        }
                    }
                    println!();
                    last_slot = slot;
                }
            }
            Err(e) => eprintln!("[{}] query failed: {e}", unix_secs()),
        }
        tokio::time::sleep(Duration::from_secs(interval)).await;
    }
}

fn unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
