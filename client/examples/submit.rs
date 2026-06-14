//! Submit a signed L1 transaction to the node's mempool through a Diaphani `.onion`.
//!
//! This is the write a sequencer issues to L1 (`POST /mempool/add/tx`). `submit_tx` is a
//! default capability — no feature flag, because you signed the tx and the node just
//! relays it:
//!
//!   cargo run -p diaphani-client --example submit -- \
//!       <onion>.onion path/to/signed_tx.json [socks_host:port]
//!
//! The node deserializes the body as a SignedMantleTx; a 2xx returns a tx hash, while a
//! validation error still proves the write reached L1 over the onion.

use diaphani_client::Client;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let onion = args
        .next()
        .ok_or("usage: submit <onion> <tx.json> [socks]")?;
    let tx_path = args
        .next()
        .ok_or("usage: submit <onion> <tx.json> [socks]")?;
    let socks = args.next().unwrap_or_else(|| "127.0.0.1:9050".to_string());

    let tx: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&tx_path)?)?;
    let node = Client::builder(onion).socks_proxy(socks).build()?;

    println!("submitting {tx_path} to /mempool/add/tx over the onion…");
    match node.submit_tx(&tx).await {
        Ok(resp) => println!("accepted: {}", serde_json::to_string_pretty(&resp)?),
        // Only a node-level reject (Error::Status) proves the write reached L1. A transport
        // failure (Unreachable: Tor proxy down / onion unreachable / client-auth missing) or
        // an oversize/decode error means it did NOT — surface it and exit non-zero rather
        // than reassuring the operator a tx was broadcast when it never left the box.
        Err(diaphani_client::Error::Status { status, body }) => {
            println!("node rejected the tx (reached L1): {status}: {body}")
        }
        Err(e) => return Err(e.into()),
    }
    Ok(())
}
