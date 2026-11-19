use iroh::{
    Endpoint, RelayMap, RelayUrl,
    endpoint::{Connection, ExportKeyingMaterialError, RelayMode, presets},
};

const EXPORTER_LABEL: &[u8] = b"EXPORTER-Cyberbaser-Iroh-Editor-WebAuthn-v1";

pub fn bound_challenge(
    connection: &Connection,
    owner: &iroh::EndpointId,
    peer: &iroh::EndpointId,
    session: &[u8; 32],
    nonce: &[u8; 32],
) -> Result<[u8; 32], ExportKeyingMaterialError> {
    let context = [ALPN, owner.as_bytes(), peer.as_bytes(), session, nonce].concat();
    let mut challenge = [0; 32];
    connection.export_keying_material(&mut challenge, EXPORTER_LABEL, &context)?;
    Ok(challenge)
}

pub const ALPN: &[u8] = b"cyberbaser/editor-carrier-spike/1";
pub const MAX_FRAME: usize = 4096;

// EOF is the boundary; retain at most one byte beyond the cap to detect oversize.
pub async fn read_frame(
    recv: &mut iroh::endpoint::RecvStream,
) -> Result<Option<Vec<u8>>, iroh::endpoint::ReadError> {
    let mut frame = [0u8; MAX_FRAME + 1];
    let mut len = 0;
    while len <= MAX_FRAME {
        let Some(n) = recv.read(&mut frame[len..]).await? else {
            return Ok(Some(frame[..len].to_vec()));
        };
        len += n;
    }
    Ok(None)
}

pub fn relay_only(relay: RelayUrl) -> iroh::endpoint::Builder {
    let builder = Endpoint::builder(presets::Minimal)
        .clear_address_lookup()
        .relay_mode(RelayMode::Custom(RelayMap::from(relay)));
    #[cfg(not(target_arch = "wasm32"))]
    let builder = builder.clear_ip_transports();
    builder
}

#[cfg(target_arch = "wasm32")]
mod browser {
    use super::*;
    use iroh::{EndpointAddr, EndpointId};
    use wasm_bindgen::prelude::*;

    fn js_err(e: impl core::fmt::Display) -> JsValue {
        JsValue::from_str(&e.to_string())
    }

    #[wasm_bindgen]
    pub struct Client {
        endpoint: Endpoint,
        connection: Connection,
    }

    #[wasm_bindgen]
    impl Client {
        pub async fn connect(owner: String, relay: String) -> Result<Client, JsValue> {
            let id: EndpointId = owner.parse().map_err(js_err)?;
            let relay: RelayUrl = relay.parse().map_err(js_err)?;
            if relay.scheme() != "http" || relay.host_str() != Some("127.0.0.1") {
                return Err(js_err("fixture accepts only loopback HTTP relay"));
            }
            let endpoint = relay_only(relay.clone()).bind().await.map_err(js_err)?;
            match endpoint
                .connect(EndpointAddr::new(id).with_relay_url(relay), ALPN)
                .await
            {
                Ok(connection) => Ok(Client {
                    endpoint,
                    connection,
                }),
                Err(error) => {
                    endpoint.close().await;
                    Err(js_err(error))
                }
            }
        }

        pub fn endpoint_id(&self) -> String {
            self.endpoint.id().to_string()
        }

        pub fn challenge(&self, session: &[u8], nonce: &[u8]) -> Result<Vec<u8>, JsValue> {
            bound_challenge(
                &self.connection,
                &self.connection.remote_id(),
                &self.endpoint.id(),
                session.try_into().map_err(js_err)?,
                nonce.try_into().map_err(js_err)?,
            )
            .map(|bytes| bytes.to_vec())
            .map_err(|_| js_err("TLS exporter unavailable"))
        }

        // Raw outbound JSON lets the harness test oversize rejection on the receiver.
        pub async fn exchange(&self, frame: Vec<u8>) -> Result<String, JsValue> {
            let (mut send, mut recv) = self.connection.open_bi().await.map_err(js_err)?;
            send.write_all(&frame).await.map_err(js_err)?;
            send.finish().map_err(js_err)?;
            let response = read_frame(&mut recv)
                .await
                .map_err(js_err)?
                .ok_or_else(|| js_err("oversize response"))?;
            String::from_utf8(response).map_err(js_err)
        }

        pub async fn close(&self) {
            self.endpoint.close().await;
        }
    }
}
