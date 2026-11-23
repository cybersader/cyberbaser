//! Test-only Iroh relay on 127.0.0.1 (plain HTTP). Prints one JSON line with
//! its URL, then runs until stdin closes. Never used outside tests.
use iroh_relay::server::{RelayConfig, Server, ServerConfig};
use std::net::{Ipv4Addr, SocketAddr};
use tokio::io::AsyncReadExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port: u16 = std::env::args().nth(1).map(|p| p.parse()).transpose()?.unwrap_or(0);
    let mut config = ServerConfig::default();
    config.relay = Some(RelayConfig::new(SocketAddr::from((Ipv4Addr::LOCALHOST, port))));
    let server = Server::spawn(config).await?;
    let address = server.http_addr().ok_or("relay did not bind")?;
    println!("{{\"relay\":\"http://{address}/\"}}");
    let mut sink = [0u8; 64];
    let mut stdin = tokio::io::stdin();
    while stdin.read(&mut sink).await.map(|n| n > 0).unwrap_or(false) {}
    server.shutdown().await?;
    Ok(())
}
