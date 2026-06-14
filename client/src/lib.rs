//! `diaphani-client` — a plug-in SDK for a **sequencer** (or any service) to read and
//! write Logos (cryptarchia) **L1** through a Diaphani-fronted node's Tor `.onion`.
//!
//! The node's HTTP API is published as a v3 onion service with **no clearnet port**;
//! this crate reaches it by routing every request through a Tor SOCKS5 proxy (`socks5h`,
//! the audited Bitcoin/Electrum/Monero pattern) so the request resolves and dials the
//! `.onion` end-to-end through Tor. You learn nothing of the node's IP, the node sees
//! only a Tor rendezvous, and there is **no direct-connect fallback** — if the proxy is
//! down the call errors rather than leaking to the clearnet.
//!
//! # What a sequencer gets
//! * **Write** — [`Client::submit_tx`] broadcasts an already-signed `SignedMantleTx` to
//!   the mempool (`POST /mempool/add/tx`). This is the normal L1 write and needs no
//!   feature flag. [`Client::post_json`] is the generic write escape hatch.
//! * **Read** — [`Client::info`] (tip/height/sync), [`Client::blocks`], [`Client::headers`],
//!   [`Client::lib_stream`] (last-irreversible), [`Client::network_info`],
//!   [`Client::mempool_metrics`], [`Client::channel`], [`Client::wallet_balance`].
//! * **Lifecycle** — [`Client::wait_until_online`] blocks until the node has finished IBD,
//!   so a sequencer doesn't start submitting against a half-synced node.
//!
//! Robust by default for an unattended service: every request is size-capped (a malicious
//! or wedged node can't OOM you), reads retry with backoff across a flaky Tor circuit, and
//! a dead proxy fails fast via a distinct [`Error::Unreachable`].
//!
//! # Safety
//! The Logos node API has **no server-side authentication**. The **only** access control
//! on the onion is v3 client authorization — run the node's onion with an authorized-clients
//! keypair (`diaphani clientauth`). The node's own-wallet `transfer-funds` (the node signs
//! and broadcasts with *its* key) is compiled out unless you enable the `node-wallet`
//! feature; submitting your own signed tx is always available.
//!
//! ```no_run
//! # async fn ex() -> Result<(), diaphani_client::Error> {
//! use diaphani_client::Client;
//! let node = Client::from_env()?;                 // DIAPHANI_ONION + DIAPHANI_SOCKS
//! let info = node.wait_until_online(Default::default()).await?;
//! println!("synced at height {}", info.height);
//! // node.submit_tx(&signed_tx).await?;           // write your signed tx to L1
//! # Ok(()) }
//! ```

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::time::{Duration, Instant};

/// Route paths on the Logos node API (mirror of `api-common::paths`).
pub mod paths {
    pub const CRYPTARCHIA_INFO: &str = "/cryptarchia/info";
    pub const CRYPTARCHIA_HEADERS: &str = "/cryptarchia/headers";
    pub const CRYPTARCHIA_LIB_STREAM: &str = "/cryptarchia/lib-stream";
    pub const NETWORK_INFO: &str = "/network/info";
    pub const MANTLE_METRICS: &str = "/mantle/metrics";
    pub const MANTLE_STATUS: &str = "/mantle/status";
    pub const STORAGE_BLOCK: &str = "/storage/block";
    pub const BLOCKS: &str = "/cryptarchia/blocks";
    pub const BLOCKS_STREAM: &str = "/cryptarchia/events/blocks/stream";
    pub const MEMPOOL_ADD_TX: &str = "/mempool/add/tx";
    pub const CHANNEL_DEPOSIT: &str = "/channel/deposit";
    pub const SDP_DECLARATION: &str = "/sdp/declaration";
    pub const SDP_ACTIVITY: &str = "/sdp/activity";
    pub const SDP_WITHDRAWAL: &str = "/sdp/withdrawal";
    pub const LEADER_CLAIM: &str = "/leader/claim";
    pub const TRANSFER_FUNDS: &str = "/wallet/transactions/transfer-funds";
}

/// Default ceiling on a single response body (32 MiB). A node is your own, but it is
/// unauthenticated and may be compromised — an unbounded `.json()` would let it OOM an
/// unattended sequencer. Override with [`Builder::max_response_bytes`].
pub const DEFAULT_MAX_RESPONSE_BYTES: usize = 32 << 20;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("http/transport: {0}")]
    Http(#[from] reqwest::Error),
    /// The node answered with a non-2xx status. Carries the status and the node's
    /// (capped) response body — for a write reject (e.g. 422 bad signature/nonce) the
    /// body is the node's actual reason, which `error_for_status()` alone would discard.
    #[error("node returned HTTP {status}: {body}")]
    Status {
        status: reqwest::StatusCode,
        body: String,
    },
    #[error("decode: {0}")]
    Decode(#[from] serde_json::Error),
    #[error("client build: {0}")]
    Build(String),
    /// The response body exceeded the configured cap (DoS guard). Carries the cap.
    #[error("response body exceeded the {0}-byte cap (raise it with Builder::max_response_bytes)")]
    TooLarge(usize),
    /// A bounded wait (e.g. [`Client::wait_until_online`]) ran out.
    #[error("timed out: {0}")]
    Timeout(String),
    /// Couldn't establish the request over Tor. reqwest can't cleanly tell
    /// "proxy down" from "onion unreachable / client-auth missing", so the
    /// message names both — the honest, actionable set of first-run causes.
    #[error(
        "couldn't reach the node over Tor (SOCKS {socks}): {source}\n  \
         · is `tor` running and listening on {socks}? (Tor Browser's SOCKS is 9150)\n  \
         · is the .onion address current, and your <name>.auth_private installed in tor's ClientOnionAuthDir?"
    )]
    Unreachable {
        socks: String,
        #[source]
        source: reqwest::Error,
    },
}

impl Error {
    /// Whether retrying the same idempotent request could plausibly succeed: a transport
    /// hiccup over Tor (proxy/circuit) or a 5xx from the node. 4xx, decode, oversize, and
    /// build errors are permanent and never retried.
    fn is_retriable(&self) -> bool {
        match self {
            Error::Unreachable { .. } => true,
            // A 5xx is the node being transiently unhealthy; 4xx is a permanent reject.
            Error::Status { status, .. } => status.is_server_error(),
            Error::Http(e) => match e.status() {
                Some(s) => s.is_server_error(),
                // connect/timeout are pre-mapped to Unreachable (see map_transport), so the
                // only Http errors that reach here are body/request issues — retry a body
                // decode that may be a truncated Tor stream.
                None => e.is_request() || e.is_body(),
            },
            _ => false,
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// How long to keep polling a node's sync state before giving up. Passed to
/// [`Client::wait_until_online`]; `Default` polls every 5s for up to 30 min.
#[derive(Debug, Clone, Copy)]
pub struct WaitOnline {
    pub poll: Duration,
    pub max_wait: Duration,
}

impl Default for WaitOnline {
    fn default() -> Self {
        Self {
            poll: Duration::from_secs(5),
            max_wait: Duration::from_secs(30 * 60),
        }
    }
}

/// Builder for a [`Client`].
pub struct Builder {
    onion: String,
    socks: String,
    timeout: Duration,
    connect_timeout: Duration,
    max_bytes: usize,
    retries: u32,
    backoff_base: Duration,
    allow_clearnet: bool,
    allow_remote_socks: bool,
}

impl Builder {
    /// `onion` is the v3 address — a bare host, optionally with a leading `http://` /
    /// `https://` scheme or a trailing `/`, which are stripped.
    pub fn new(onion: impl Into<String>) -> Self {
        Self {
            onion: onion.into(),
            socks: "127.0.0.1:9050".to_string(),
            timeout: Duration::from_secs(60), // onion round-trips are slow; be tolerant
            connect_timeout: Duration::from_secs(30),
            max_bytes: DEFAULT_MAX_RESPONSE_BYTES,
            retries: 2,
            backoff_base: Duration::from_millis(500),
            allow_clearnet: false,
            allow_remote_socks: false,
        }
    }

    /// Address of your Tor SOCKS5 proxy (default `127.0.0.1:9050`; Tor Browser is `9150`).
    pub fn socks_proxy(mut self, host_port: impl Into<String>) -> Self {
        self.socks = host_port.into();
        self
    }

    /// Per-request timeout (default 60s — onion latency can be seconds).
    pub fn timeout(mut self, d: Duration) -> Self {
        self.timeout = d;
        self
    }

    /// Connect timeout — how long to wait to establish the SOCKS/onion connection before
    /// failing (default 30s). A short value surfaces a dead proxy fast, distinct from a
    /// slow-but-alive request.
    pub fn connect_timeout(mut self, d: Duration) -> Self {
        self.connect_timeout = d;
        self
    }

    /// Cap on a single response body (default [`DEFAULT_MAX_RESPONSE_BYTES`] = 32 MiB).
    /// Reads beyond this fail with [`Error::TooLarge`] instead of buffering unbounded.
    pub fn max_response_bytes(mut self, n: usize) -> Self {
        self.max_bytes = n;
        self
    }

    /// How many times to retry an idempotent **read** on a transient failure (Tor hiccup
    /// or node 5xx) before giving up (default 2 → up to 3 attempts). Writes never retry.
    pub fn retries(mut self, n: u32) -> Self {
        self.retries = n;
        self
    }

    /// Base for the exponential read-retry backoff (default 500ms → 500ms, 1s, 2s, …,
    /// capped at 8s). The actual sleep before attempt _k_ is `base * 2^(k-1)`.
    pub fn retry_backoff(mut self, base: Duration) -> Self {
        self.backoff_base = base;
        self
    }

    /// Permit a non-`.onion` target (escape hatch for loopback testing). By default
    /// `build()` refuses a clearnet host — this crate exists to reach a `.onion`, so a
    /// misconfigured/hostile address must not silently route your traffic elsewhere.
    pub fn allow_clearnet(mut self) -> Self {
        self.allow_clearnet = true;
        self
    }

    /// Permit a non-loopback SOCKS proxy (escape hatch for an advanced off-box Tor setup).
    /// By default `build()` REFUSES one: with `socks5h` the proxy resolves AND dials the
    /// `.onion`, so a poisoned/typo'd off-box proxy would carry every read + signed-tx write
    /// AND learn which `.onion` you query — linking your real ip to the node. Symmetric with
    /// [`Builder::allow_clearnet`]: dangerous by default, opt in explicitly.
    pub fn allow_remote_socks(mut self) -> Self {
        self.allow_remote_socks = true;
        self
    }

    pub fn build(self) -> Result<Client> {
        // The SOCKS proxy is the trust anchor: with socks5h it also RESOLVES and DIALS the
        // .onion, so a non-loopback proxy (a poisoned env, a typo, an off-box host) would
        // route every node request — reads AND signed-tx writes — and the .onion resolution
        // through that host, linking the operator's real ip to the node, while the .onion
        // target guard below still passes. Fail CLOSED at this single choke point so EVERY
        // consumer (the SDK builder, the explorer, the submit/sequencer examples — all of which
        // feed --socks straight to socks_proxy() and bypass from_env's check) is protected.
        // Symmetric with allow_clearnet: an advanced off-box setup must opt in via
        // allow_remote_socks() (a missed stderr warning on an unattended service is not enough).
        if !self.allow_remote_socks && !is_loopback_socks(self.socks.trim()) {
            return Err(Error::Build(format!(
                "SOCKS proxy {:?} is not a loopback proxy; with socks5h it would route all node traffic and .onion resolution through that host (linking your real ip to the node). Use a local Tor SOCKS (127.0.0.1:9050), or call .allow_remote_socks() if you truly trust this off-box proxy",
                self.socks
            )));
        }
        let host = self
            .onion
            .trim()
            .trim_end_matches('/')
            .trim_start_matches("http://")
            .trim_start_matches("https://");
        // Reject a still-embedded scheme (e.g. a bare "https://" that the strip above only
        // partially matched, or "ftp://…") rather than formatting it into a malformed
        // `http://https://…onion` that fails confusingly at request time. We want a bare host.
        if host.contains("://") {
            return Err(Error::Build(format!(
                "pass a bare onion host, not a URL (got {host:?})"
            )));
        }
        // Fail closed on a clearnet target unless explicitly opted in: the whole point
        // of this crate is the .onion path, and silently honoring a clearnet host routes
        // your traffic to an arbitrary internet endpoint through Tor with no warning.
        if !self.allow_clearnet && !host.ends_with(".onion") {
            return Err(Error::Build(format!(
                "target host {host:?} is not a .onion; refusing to dial clearnet (use .allow_clearnet() for loopback testing)"
            )));
        }
        // socks5h => the proxy (Tor) resolves the .onion; the host never leaks DNS.
        let proxy = reqwest::Proxy::all(format!("socks5h://{}", self.socks))
            .map_err(|e| Error::Build(e.to_string()))?;
        let http = reqwest::Client::builder()
            .proxy(proxy)
            .timeout(self.timeout)
            .connect_timeout(self.connect_timeout)
            .build()?;
        Ok(Client {
            http,
            base: format!("http://{host}"),
            socks: self.socks,
            max_bytes: self.max_bytes,
            retries: self.retries,
            backoff_base: self.backoff_base,
        })
    }
}

/// A handle to one Diaphani-fronted node. Cheap to clone (shares the connection pool).
#[derive(Clone, Debug)]
pub struct Client {
    http: reqwest::Client,
    base: String,
    socks: String,
    max_bytes: usize,
    retries: u32,
    backoff_base: Duration,
}

impl Client {
    pub fn builder(onion: impl Into<String>) -> Builder {
        Builder::new(onion)
    }

    /// Build from the environment: `DIAPHANI_ONION` (required — the node's v3 .onion,
    /// shown by `diaphani status`) and `DIAPHANI_SOCKS` (optional Tor SOCKS port, default
    /// `127.0.0.1:9050`). The natural way to hand the address to a sequencer without
    /// hardcoding it. (The .onion address is a public identifier, not a secret — the
    /// access control is the client-auth key, which this never reads from the env.)
    pub fn from_env() -> Result<Client> {
        let onion = std::env::var("DIAPHANI_ONION").map_err(|_| {
            Error::Build(
                "set DIAPHANI_ONION to the node's .onion address (see `diaphani status`)".into(),
            )
        })?;
        let mut b = Builder::new(onion);
        if let Ok(s) = std::env::var("DIAPHANI_SOCKS") {
            let s = s.trim();
            if !s.is_empty() {
                // A non-loopback DIAPHANI_SOCKS (poisoned env / typo) would route every
                // request + the .onion resolution through that host. build() (the single choke
                // point every consumer hits) now FAILS CLOSED on it; an advanced off-box setup
                // opts in via DIAPHANI_ALLOW_REMOTE_SOCKS=1 (mirrors .allow_remote_socks()).
                b = b.socks_proxy(s);
            }
        }
        if env_flag("DIAPHANI_ALLOW_REMOTE_SOCKS") {
            b = b.allow_remote_socks();
        }
        b.build()
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    // Map a reqwest error to the actionable Unreachable when it's a connect/timeout
    // (proxy down / onion unreachable / auth missing); otherwise keep it as Http.
    fn map_transport(&self, e: reqwest::Error) -> Error {
        if e.is_connect() || e.is_timeout() {
            Error::Unreachable {
                socks: self.socks.clone(),
                source: e,
            }
        } else {
            Error::Http(e)
        }
    }

    // Read a response body into memory, refusing to buffer past the cap. Streams chunk by
    // chunk so an oversized/never-ending body is rejected early rather than OOMing us.
    async fn read_capped(&self, resp: reqwest::Response) -> Result<bytes::Bytes> {
        use futures_util::StreamExt;
        let mut buf: Vec<u8> = Vec::new();
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| self.map_transport(e))?;
            if buf.len() + chunk.len() > self.max_bytes {
                return Err(Error::TooLarge(self.max_bytes));
            }
            buf.extend_from_slice(&chunk);
        }
        Ok(buf.into())
    }

    fn backoff(&self, attempt: u32) -> Duration {
        // base * 2^(attempt-1), capped at 8s.
        let mult = 1u32
            .checked_shl(attempt.saturating_sub(1))
            .unwrap_or(u32::MAX);
        self.backoff_base
            .saturating_mul(mult)
            .min(Duration::from_secs(8))
    }

    // One GET attempt: send, map transport errors, read the body capped, reject non-2xx
    // (keeping the node's body as the error reason).
    async fn get_bytes_once(&self, url: &str) -> Result<bytes::Bytes> {
        let resp = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| self.map_transport(e))?;
        self.checked_body(resp).await
    }

    // Read the (capped) body, then fail on a non-2xx status — but only AFTER reading, so
    // the node's diagnostic body (e.g. why a tx was rejected) survives instead of being
    // dropped by `error_for_status()`. The body stays bounded by the existing read cap.
    async fn checked_body(&self, resp: reqwest::Response) -> Result<bytes::Bytes> {
        let status = resp.status();
        let body = self.read_capped(resp).await?;
        if !status.is_success() {
            return Err(Error::Status {
                status,
                body: String::from_utf8_lossy(&body).into_owned(),
            });
        }
        Ok(body)
    }

    // GET with retry/backoff for an idempotent read (transport hiccup or 5xx).
    async fn get_bytes(&self, path: &str) -> Result<bytes::Bytes> {
        let url = self.url(path);
        let mut attempt: u32 = 0;
        loop {
            match self.get_bytes_once(&url).await {
                Ok(b) => return Ok(b),
                Err(e) if attempt < self.retries && e.is_retriable() => {
                    attempt += 1;
                    tokio::time::sleep(self.backoff(attempt)).await;
                }
                Err(e) => return Err(e),
            }
        }
    }

    fn from_slice<T: DeserializeOwned>(bytes: &[u8]) -> Result<T> {
        // Tolerate an empty body (some endpoints answer 200 with no JSON) by deserializing
        // into `null` so `serde_json::Value` / Option<T> targets succeed.
        if bytes.is_empty() {
            return Ok(serde_json::from_str("null")?);
        }
        Ok(serde_json::from_slice(bytes)?)
    }

    // ── generic, version-robust escape hatches ───────────────────────────────
    /// GET any path, returning untyped JSON (useful across node versions).
    pub async fn get_json(&self, path: &str) -> Result<serde_json::Value> {
        Self::from_slice(&self.get_bytes(path).await?)
    }

    /// GET any path, deserializing into `T`.
    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        Self::from_slice(&self.get_bytes(path).await?)
    }

    /// POST any path with a JSON body (the generic write escape hatch). Does NOT retry —
    /// a write is not assumed idempotent. Size-capped like every read.
    pub async fn post_json(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let resp = self
            .http
            .post(self.url(path))
            .json(body)
            .send()
            .await
            .map_err(|e| self.map_transport(e))?;
        Self::from_slice(&self.checked_body(resp).await?)
    }

    // ── L1 WRITE (the sequencer's job) ───────────────────────────────────────
    /// `POST /mempool/add/tx` — broadcast an already-signed `SignedMantleTx` to L1. The
    /// node deserializes the body and a 2xx returns a tx hash. This is the normal
    /// sequencer write; it needs no feature flag (you signed it, the node just relays it).
    pub async fn submit_tx(&self, signed_tx: &serde_json::Value) -> Result<serde_json::Value> {
        self.post_json(paths::MEMPOOL_ADD_TX, signed_tx).await
    }

    // ── typed read-only convenience ──────────────────────────────────────────
    /// `GET /cryptarchia/info` — sync mode, tip, height.
    pub async fn info(&self) -> Result<CryptarchiaInfo> {
        self.get(paths::CRYPTARCHIA_INFO).await
    }

    /// `GET /network/info` — libp2p peer/connection counts and listen addrs.
    pub async fn network_info(&self) -> Result<NetworkInfo> {
        self.get(paths::NETWORK_INFO).await
    }

    /// `GET /cryptarchia/blocks?slot_from=&slot_to=` — blocks in a slot range.
    pub async fn blocks(&self, slot_from: u64, slot_to: u64) -> Result<serde_json::Value> {
        self.get_json(&format!(
            "{}?slot_from={slot_from}&slot_to={slot_to}",
            paths::BLOCKS
        ))
        .await
    }

    /// `GET /cryptarchia/headers` — recent block headers.
    pub async fn headers(&self) -> Result<serde_json::Value> {
        self.get_json(paths::CRYPTARCHIA_HEADERS).await
    }

    /// `GET /cryptarchia/lib-stream` — the last-irreversible-block view (finalized tip).
    /// Returned untyped; a sequencer typically reads `height`/`lib` from it.
    pub async fn lib_stream(&self) -> Result<serde_json::Value> {
        self.get_json(paths::CRYPTARCHIA_LIB_STREAM).await
    }

    /// `GET /mantle/status` — mantle (execution) status.
    pub async fn mantle_status(&self) -> Result<serde_json::Value> {
        self.get_json(paths::MANTLE_STATUS).await
    }

    /// `GET /mantle/metrics` — mempool metrics.
    pub async fn mempool_metrics(&self) -> Result<serde_json::Value> {
        self.get_json(paths::MANTLE_METRICS).await
    }

    /// `GET /channel/:id` — channel state.
    pub async fn channel(&self, id: &str) -> Result<serde_json::Value> {
        self.get_json(&format!("/channel/{}", encode_segment(id)))
            .await
    }

    /// `GET /wallet/:public_key/balance` — read-only, but exposes balances/notes.
    pub async fn wallet_balance(&self, public_key: &str) -> Result<serde_json::Value> {
        self.get_json(&format!("/wallet/{}/balance", encode_segment(public_key)))
            .await
    }

    // ── lifecycle ────────────────────────────────────────────────────────────
    /// Poll `GET /cryptarchia/info` until the node reports `mode == "Online"` (IBD done,
    /// following the tip) or the budget runs out. A sequencer calls this before it starts
    /// submitting, so it doesn't write against a half-synced node. Transient read errors
    /// within the budget are tolerated (the node may still be starting); the final state
    /// surfaces as [`Error::Timeout`] (never Online) or the last hard error.
    pub async fn wait_until_online(&self, opts: WaitOnline) -> Result<CryptarchiaInfo> {
        let start = Instant::now();
        loop {
            match self.info().await {
                Ok(i) if i.is_online() => return Ok(i),
                Ok(_) => {} // responding but still in IBD
                // A permanent error (bad onion/auth, oversize) won't fix itself — fail now
                // with its full detail rather than masking it behind a generic timeout.
                Err(e) if !e.is_retriable() => return Err(e),
                Err(_) => {} // transient (node still starting) — keep polling
            }
            if start.elapsed() >= opts.max_wait {
                return Err(Error::Timeout(format!(
                    "node did not reach Online within {:?} (waited {:?})",
                    opts.max_wait,
                    start.elapsed()
                )));
            }
            // Floor the poll so a zero/tiny interval can't busy-spin the onion between
            // info() round-trips.
            tokio::time::sleep(opts.poll.max(Duration::from_millis(100))).await;
        }
    }

    // ── node-WALLET endpoint (feature-gated; the node signs with ITS key) ─────
    /// `POST /wallet/transactions/transfer-funds` — the node wallet signs and broadcasts
    /// a transfer. **Highly sensitive; only with the `node-wallet` feature + onion
    /// client-auth, and only if you operate the node and trust it with funds.**
    #[cfg(feature = "node-wallet")]
    pub async fn transfer_funds(&self, body: &serde_json::Value) -> Result<serde_json::Value> {
        self.post_json(paths::TRANSFER_FUNDS, body).await
    }
}

// Whether a `host:port` SOCKS endpoint points at the local machine — `localhost`, an IPv4
// loopback (127.0.0.0/8), or `::1`. A non-parseable / non-loopback host returns false so the
// caller can warn. Consulted by `Builder::build()` (the single choke point every consumer
// hits) to flag a likely-misconfigured off-box proxy; never used to route.
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

// Is an env var set to a truthy value (`1`/`true`/`yes`/`on`, case-insensitive)? Used only
// for the deliberately-opt-in off-box-SOCKS escape hatch — an unset/empty/falsey value keeps
// the fail-closed default.
fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

// Percent-encode one URL path segment so a caller-supplied `&str` id can't rewrite the
// request target: a raw `/`, `?`, `#`, or `%` would otherwise add a path component,
// start a query/fragment, or traverse (`../`) to a different node route. We keep only
// the RFC-3986 unreserved set (ALPHA / DIGIT / `-` `.` `_` `~`) and escape the rest.
fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(
                char::from_digit((b >> 4) as u32, 16)
                    .unwrap()
                    .to_ascii_uppercase(),
            );
            out.push(
                char::from_digit((b & 0xf) as u32, 16)
                    .unwrap()
                    .to_ascii_uppercase(),
            );
        }
    }
    out
}

// Tolerant response types: `#[serde(default)]` so a field added/removed across
// node versions (e.g. pinned 0.1.2 vs 0.2.x) doesn't break deserialization.
// `mode` is a JSON string on the wire (empirically confirmed); `tip`/`lib` are
// kept as raw JSON since the on-wire shape of HeaderId may vary by version.

/// Response of `GET /cryptarchia/info`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CryptarchiaInfo {
    /// Last irreversible block id.
    pub lib: serde_json::Value,
    pub lib_slot: serde_json::Value,
    /// Current tip block id.
    pub tip: serde_json::Value,
    pub slot: serde_json::Value,
    pub height: u64,
    /// Sync state, e.g. "Bootstrapping" / "Online".
    pub mode: String,
}

impl CryptarchiaInfo {
    /// True once the node has finished IBD and is following the tip.
    pub fn is_online(&self) -> bool {
        self.mode.eq_ignore_ascii_case("online")
    }
}

/// Response of `GET /network/info`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct NetworkInfo {
    pub peer_id: String,
    pub n_peers: usize,
    pub n_connections: u32,
    pub n_pending_connections: u32,
    pub listen_addresses: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_normalizes_onion_and_proxy() {
        let c = Client::builder("http://abc.onion/").build().unwrap();
        assert_eq!(c.base, "http://abc.onion");
        let c2 = Client::builder("abc.onion")
            .socks_proxy("127.0.0.1:9150")
            .build()
            .unwrap();
        assert_eq!(c2.base, "http://abc.onion");
        // an https:// scheme is stripped too (not formatted into a malformed URL)
        let c3 = Client::builder("https://abc.onion/").build().unwrap();
        assert_eq!(c3.base, "http://abc.onion");
        // a leftover embedded scheme is rejected, not silently mangled
        assert!(matches!(
            Client::builder("ftp://abc.onion").build().unwrap_err(),
            Error::Build(_)
        ));
    }

    #[test]
    fn clearnet_host_is_refused_by_default() {
        let err = Client::builder("example.com").build().unwrap_err();
        assert!(matches!(err, Error::Build(_)));
        // …unless explicitly opted in (loopback testing).
        assert!(Client::builder("127.0.0.1:8080")
            .allow_clearnet()
            .build()
            .is_ok());
    }

    #[test]
    fn builder_tuning_is_applied() {
        let c = Client::builder("abc.onion")
            .max_response_bytes(1234)
            .retries(5)
            .retry_backoff(Duration::from_millis(10))
            .build()
            .unwrap();
        assert_eq!(c.max_bytes, 1234);
        assert_eq!(c.retries, 5);
        // backoff is exponential, capped at 8s
        assert_eq!(c.backoff(1), Duration::from_millis(10));
        assert_eq!(c.backoff(2), Duration::from_millis(20));
        assert_eq!(c.backoff(40), Duration::from_secs(8));
    }

    #[test]
    fn info_deserializes_and_is_tolerant() {
        // full shape
        let full: CryptarchiaInfo = serde_json::from_str(
            r#"{"lib":"0xaa","lib_slot":1,"tip":"0xbb","slot":2,"height":42,"mode":"Online"}"#,
        )
        .unwrap();
        assert_eq!(full.height, 42);
        assert!(full.is_online());
        // older/leaner node missing some fields must still parse
        let lean: CryptarchiaInfo =
            serde_json::from_str(r#"{"height":7,"mode":"Bootstrapping"}"#).unwrap();
        assert_eq!(lean.height, 7);
        assert!(!lean.is_online());
    }

    #[test]
    fn empty_body_decodes_as_null_value() {
        let v: serde_json::Value = Client::from_slice(b"").unwrap();
        assert!(v.is_null());
    }

    #[test]
    fn from_env_requires_onion_then_builds() {
        // One fn (not two) so the process-global env vars aren't raced by the
        // parallel test runner.
        std::env::remove_var("DIAPHANI_ONION");
        std::env::remove_var("DIAPHANI_SOCKS");
        let err = Client::from_env().unwrap_err();
        assert!(matches!(err, Error::Build(_)));
        assert!(
            err.to_string().contains("DIAPHANI_ONION"),
            "hint names the var"
        );

        std::env::set_var("DIAPHANI_ONION", "http://abc.onion/");
        std::env::set_var("DIAPHANI_SOCKS", "127.0.0.1:9150");
        let c = Client::from_env().expect("builds from env");
        assert_eq!(c.base, "http://abc.onion");
        assert_eq!(c.socks, "127.0.0.1:9150");
        std::env::remove_var("DIAPHANI_ONION");
        std::env::remove_var("DIAPHANI_SOCKS");
    }

    #[test]
    fn loopback_socks_is_recognized() {
        for ok in [
            "127.0.0.1:9050",
            "127.0.0.1",
            "localhost:9050",
            "[::1]:9050",
            "::1",
        ] {
            assert!(is_loopback_socks(ok), "{ok} should be loopback");
        }
        for bad in [
            "10.0.0.5:9050",
            "evil.example:9050",
            "192.168.1.9:1080",
            "8.8.8.8:9050",
        ] {
            assert!(!is_loopback_socks(bad), "{bad} should NOT be loopback");
        }
    }

    #[test]
    fn network_info_deserializes() {
        let n: NetworkInfo = serde_json::from_str(
            r#"{"peer_id":"12D3","n_peers":5,"n_connections":5,"n_pending_connections":0,"listen_addresses":["/ip4/1.2.3.4/udp/3000/quic-v1"]}"#,
        )
        .unwrap();
        assert_eq!(n.n_peers, 5);
        assert_eq!(n.listen_addresses.len(), 1);
    }
}
