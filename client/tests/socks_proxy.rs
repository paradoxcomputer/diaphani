//! Runtime regression test: prove the client actually routes requests THROUGH a
//! SOCKS5 proxy (socks5h) and reaches the target. This guards the `reqwest`
//! feature trim — a build can succeed while the SOCKS connector is silently not
//! wired in (history: `default-features=false` once compiled but reqwest never
//! invoked the proxy). We assert both: the proxy was used AND the body returned.
//!
//! No network: a tiny in-process SOCKS5 CONNECT proxy + a one-shot HTTP/1.1
//! server, both on loopback ephemeral ports.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const BODY: &str = r#"{"lib":"0x0","lib_slot":1,"tip":"0x1","slot":2,"height":7,"mode":"Online"}"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn client_routes_through_socks5_proxy() {
    // 1) one-shot HTTP server: replies to /cryptarchia/info with BODY.
    let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let http_addr = http.local_addr().unwrap();
    tokio::spawn(async move {
        if let Ok((mut s, _)) = http.accept().await {
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf).await; // consume the request line/headers
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                BODY.len(),
                BODY
            );
            let _ = s.write_all(resp.as_bytes()).await;
            let _ = s.flush().await;
        }
    });

    // 2) minimal SOCKS5 CONNECT proxy; counts how many times it was used.
    let used = Arc::new(AtomicUsize::new(0));
    let socks = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let socks_addr = socks.local_addr().unwrap();
    {
        let used = used.clone();
        tokio::spawn(async move {
            if let Ok((c, _)) = socks.accept().await {
                used.fetch_add(1, Ordering::SeqCst);
                let _ = handle_socks(c).await;
            }
        });
    }

    // 3) the client, pointed at the SOCKS proxy, using the HTTP server's addr as
    //    the "onion" host (socks5h => the proxy resolves/dials host:port).
    let node = diaphani_client::Client::builder(http_addr.to_string())
        .socks_proxy(socks_addr.to_string())
        .timeout(std::time::Duration::from_secs(10))
        .allow_clearnet() // a loopback addr, not a .onion — opt out of the onion-only guard
        .build()
        .expect("build client");

    let info = node.info().await.expect("GET /cryptarchia/info via SOCKS5");
    assert_eq!(info.height, 7, "body must come back through the proxy");
    assert!(info.is_online());
    assert_eq!(
        used.load(Ordering::SeqCst),
        1,
        "the request MUST have transited the SOCKS5 proxy (socks connector wired in)"
    );
}

// Handle one SOCKS5 client: no-auth handshake, CONNECT, then splice bidirectionally.
async fn handle_socks(mut c: TcpStream) -> std::io::Result<()> {
    // greeting: VER, NMETHODS, METHODS...
    let mut head = [0u8; 2];
    c.read_exact(&mut head).await?;
    let nmethods = head[1] as usize;
    let mut methods = vec![0u8; nmethods];
    c.read_exact(&mut methods).await?;
    c.write_all(&[0x05, 0x00]).await?; // VER, METHOD=no-auth

    // request: VER, CMD, RSV, ATYP, ADDR, PORT
    let mut req = [0u8; 4];
    c.read_exact(&mut req).await?;
    assert_eq!(req[0], 0x05);
    assert_eq!(req[1], 0x01, "only CONNECT");
    let host = match req[3] {
        0x01 => {
            let mut a = [0u8; 4];
            c.read_exact(&mut a).await?;
            format!("{}.{}.{}.{}", a[0], a[1], a[2], a[3])
        }
        0x03 => {
            let mut l = [0u8; 1];
            c.read_exact(&mut l).await?;
            let mut name = vec![0u8; l[0] as usize];
            c.read_exact(&mut name).await?;
            String::from_utf8_lossy(&name).to_string()
        }
        other => panic!("unexpected ATYP {other}"),
    };
    let mut p = [0u8; 2];
    c.read_exact(&mut p).await?;
    let port = u16::from_be_bytes(p);

    let upstream = TcpStream::connect((host.as_str(), port)).await?;
    // reply: VER, REP=0, RSV, ATYP=IPv4, BND.ADDR=0, BND.PORT=0
    c.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
        .await?;

    let (mut cr, mut cw) = c.into_split();
    let (mut ur, mut uw) = upstream.into_split();
    let a = tokio::spawn(async move { tokio::io::copy(&mut cr, &mut uw).await });
    let b = tokio::spawn(async move { tokio::io::copy(&mut ur, &mut cw).await });
    let _ = tokio::join!(a, b);
    Ok(())
}
