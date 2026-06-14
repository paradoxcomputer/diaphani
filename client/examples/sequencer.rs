//! A worked sequencer integration: connect to L1 over Tor, wait for the node to sync,
//! then read + write. This is the shape a sequencer drops into its own service.
//!
//!   DIAPHANI_ONION=<addr>.onion DIAPHANI_SOCKS=127.0.0.1:9050 \
//!       cargo run -p diaphani-client --example sequencer
//!
//! It waits until the node is Online, prints chain + peer state, and shows where a real
//! signed tx would be submitted. No tx is sent (none is provided).

use diaphani_client::{Client, WaitOnline};
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Connect. Build from the environment (DIAPHANI_ONION + optional DIAPHANI_SOCKS,
    //    the natural handoff from `diaphani status`), or via the builder when you want to
    //    tune an unattended service. Bounded bodies, a connect timeout, and read retries
    //    across a flaky Tor circuit are all on by default.
    let node = match std::env::var("DIAPHANI_ONION") {
        Ok(onion) => {
            let socks = std::env::var("DIAPHANI_SOCKS").unwrap_or_else(|_| "127.0.0.1:9050".into());
            Client::builder(onion)
                .socks_proxy(socks)
                .retries(4) // a long-running sequencer can afford more read retries
                .connect_timeout(Duration::from_secs(20))
                .build()?
        }
        Err(_) => {
            return Err("set DIAPHANI_ONION to the node's .onion (see `diaphani status`)".into())
        }
    };

    // 2. Wait for L1 to be synced before doing anything that depends on the tip.
    println!("waiting for the node to reach Online (this can take a while on first sync)…");
    let info = node.wait_until_online(WaitOnline::default()).await?;
    println!("✓ Online at height {} (tip {})", info.height, info.tip);

    // 3. Read L1 state.
    let net = node.network_info().await?;
    println!("peers: {} ({} connections)", net.n_peers, net.n_connections);
    if let Ok(metrics) = node.mempool_metrics().await {
        println!("mempool: {metrics}");
    }

    // 4. Write L1 state. A sequencer constructs + signs its own SignedMantleTx and submits
    //    it; the node only relays. (Here we just show the call — fill in your signed tx.)
    //
    //    let signed_tx: serde_json::Value = build_and_sign(...);
    //    let receipt = node.submit_tx(&signed_tx).await?;
    //    println!("submitted: {receipt}");
    println!("(no tx provided — see `examples/submit.rs` to broadcast a signed tx)");

    Ok(())
}
