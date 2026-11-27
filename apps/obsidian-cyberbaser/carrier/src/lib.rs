//! Relay-only Iroh client for the Cyberbaser Obsidian plugin.
//!
//! The browser build of Iroh cannot open UDP sockets, so every connection goes
//! through the relay named in the node's ticket. The relay only forwards
//! end-to-end encrypted QUIC; it cannot read or forge requests.
//! One request per bidirectional stream: the caller's bytes, finish, read to end.

pub const MAX_RESPONSE_BYTES: usize = 512 * 1024;

#[cfg(target_arch = "wasm32")]
mod browser {
    use super::MAX_RESPONSE_BYTES;
    use iroh::{
        Endpoint, EndpointAddr, RelayMap, SecretKey,
        endpoint::{Connection, RelayMode, presets},
    };
    use iroh_tickets::endpoint::EndpointTicket;
    use wasm_bindgen::prelude::*;

    fn js_err(e: impl core::fmt::Display) -> JsValue {
        JsValue::from_str(&e.to_string())
    }

    #[wasm_bindgen]
    pub struct Session {
        endpoint: Endpoint,
        connection: Connection,
    }

    /// The relay URL inside a node ticket, or undefined when it has none.
    #[wasm_bindgen(js_name = ticketRelay)]
    pub fn ticket_relay(ticket: String) -> Result<Option<String>, JsValue> {
        let ticket: EndpointTicket = ticket.parse().map_err(js_err)?;
        Ok(ticket.endpoint_addr().relay_urls().next().map(|url| url.to_string()))
    }

    #[wasm_bindgen]
    impl Session {
        /// `secret` is this device's stable 32-byte Iroh key; the node's device
        /// record names the endpoint it derives, so it must not change.
        pub async fn open(secret: Vec<u8>, ticket: String, alpn: String) -> Result<Session, JsValue> {
            let bytes: [u8; 32] = secret.as_slice().try_into().map_err(|_| js_err("secret must be 32 bytes"))?;
            let ticket: EndpointTicket = ticket.parse().map_err(js_err)?;
            let addr = ticket.endpoint_addr();
            let relay = addr.relay_urls().next().cloned().ok_or_else(|| js_err("ticket names no relay"))?;
            let endpoint = Endpoint::builder(presets::Minimal)
                .clear_address_lookup()
                .secret_key(SecretKey::from_bytes(&bytes))
                .relay_mode(RelayMode::Custom(RelayMap::from(relay.clone())))
                .bind()
                .await
                .map_err(js_err)?;
            match endpoint.connect(EndpointAddr::new(addr.id).with_relay_url(relay), alpn.as_bytes()).await {
                Ok(connection) => Ok(Session { endpoint, connection }),
                Err(error) => {
                    endpoint.close().await;
                    Err(js_err(error))
                }
            }
        }

        #[wasm_bindgen(js_name = nodeId)]
        pub fn node_id(&self) -> String {
            self.connection.remote_id().to_string()
        }

        #[wasm_bindgen(js_name = endpointId)]
        pub fn endpoint_id(&self) -> String {
            self.endpoint.id().to_string()
        }

        pub async fn exchange(&self, frame: Vec<u8>) -> Result<Vec<u8>, JsValue> {
            let (mut send, mut recv) = self.connection.open_bi().await.map_err(js_err)?;
            send.write_all(&frame).await.map_err(js_err)?;
            send.finish().map_err(js_err)?;
            let mut out = Vec::new();
            let mut buf = [0u8; 16 * 1024];
            loop {
                match recv.read(&mut buf).await.map_err(js_err)? {
                    None => return Ok(out),
                    Some(n) => {
                        out.extend_from_slice(&buf[..n]);
                        if out.len() > MAX_RESPONSE_BYTES {
                            return Err(js_err("oversize response"));
                        }
                    }
                }
            }
        }

        pub async fn close(&self) {
            self.connection.close(0u32.into(), b"");
            self.endpoint.close().await;
        }
    }
}
