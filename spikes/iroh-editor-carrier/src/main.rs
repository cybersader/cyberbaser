use std::{
    collections::HashSet,
    net::{Ipv4Addr, SocketAddr},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, ensure};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use cyberbaser_iroh_editor_carrier::{ALPN, MAX_FRAME, bound_challenge, read_frame, relay_only};
use iroh::{EndpointId, RelayUrl, endpoint::Connection, endpoint::QuicTransportConfig};
use iroh_relay::server::{RelayConfig, Server, ServerConfig};
use ring::{
    digest::{SHA256, digest},
    rand::{SecureRandom, SystemRandom},
    signature::{ECDSA_P256_SHA256_ASN1, UnparsedPublicKey},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{io::AsyncBufReadExt, task::JoinSet, time::timeout};

const RP: &str = "localhost";
const CHALLENGE_TTL: Duration = Duration::from_secs(30);
const STREAM_TIMEOUT: Duration = Duration::from_secs(5);
const SESSION_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_REQUESTS: usize = 128;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Enrollment {
    origin: String,
    credential_id: String,
    public_key: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    v: u32,
    id: u32,
    body: Operation,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", deny_unknown_fields)]
enum Operation {
    Challenge,
    Authenticate(Assertion),
    EchoRead { text: String },
    FakeSubmit { text: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Assertion {
    credential_id: String,
    client_data_json: String,
    authenticator_data: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientData {
    #[serde(rename = "type")]
    kind: String,
    origin: String,
    challenge: String,
    #[serde(default)]
    cross_origin: bool,
    top_origin: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Principal {
    id: &'static str,
    method: &'static str,
    session_id: String,
    authenticated_at: u64,
}

struct Session {
    id: [u8; 32],
    peer: EndpointId,
    owner: EndpointId,
    challenge: Option<(String, Instant)>,
    principal: Option<Principal>,
    seen: HashSet<u32>,
}

fn random_32() -> Result<[u8; 32]> {
    let mut value = [0; 32];
    SystemRandom::new()
        .fill(&mut value)
        .map_err(|_| anyhow::anyhow!("random unavailable"))?;
    Ok(value)
}

fn verify_assertion(enrolled: &Enrollment, challenge: &str, input: Assertion) -> Result<()> {
    ensure!(input.credential_id == enrolled.credential_id, "credential");
    let client_bytes = B64.decode(input.client_data_json)?;
    let client: ClientData = serde_json::from_slice(&client_bytes)?;
    ensure!(
        client.kind == "webauthn.get" && client.challenge == challenge,
        "challenge"
    );
    ensure!(
        client.origin == enrolled.origin && !client.cross_origin && client.top_origin.is_none(),
        "origin"
    );
    let mut signed = B64.decode(input.authenticator_data)?;
    // Fixture supports only its virtual ES256 authenticator (no extension data).
    ensure!(
        signed.len() == 37 && &signed[..32] == digest(&SHA256, RP.as_bytes()).as_ref(),
        "RP ID"
    );
    ensure!(signed[32] & 0xc5 == 0x05, "UP/UV or unsupported data");
    signed.extend_from_slice(digest(&SHA256, &client_bytes).as_ref());
    UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, B64.decode(&enrolled.public_key)?)
        .verify(&signed, &B64.decode(input.signature)?)
        .map_err(|_| anyhow::anyhow!("signature"))
}

fn fake_command(principal: Option<&Principal>, op: Operation) -> Result<Value, &'static str> {
    let principal = principal
        .filter(|p| p.id == "fixture-owner")
        .ok_or("principal_required")?;
    match op {
        Operation::EchoRead { text } if text.len() <= 512 => Ok(json!({"text": text})),
        Operation::FakeSubmit { text } if text.len() <= 512 => {
            Ok(json!({"accepted": true, "principal": principal}))
        }
        _ => Err("invalid_command"),
    }
}

impl Session {
    fn dispatch(
        &mut self,
        op: Operation,
        enrolled: &Enrollment,
        connection: &Connection,
    ) -> Result<Value, &'static str> {
        match op {
            Operation::Challenge => {
                if self.principal.is_some() {
                    return Err("already_authenticated");
                }
                let nonce = random_32().map_err(|_| "unavailable")?;
                let value = bound_challenge(connection, &self.owner, &self.peer, &self.id, &nonce)
                    .map_err(|_| "unavailable")?;
                let value = B64.encode(value);
                self.challenge = Some((value.clone(), Instant::now()));
                Ok(
                    json!({"challenge": value, "sessionId": B64.encode(self.id), "nonce": B64.encode(nonce)}),
                )
            }
            Operation::Authenticate(assertion) => {
                let (challenge, issued) = self.challenge.take().ok_or("no_pending_challenge")?;
                if issued.elapsed() >= CHALLENGE_TTL
                    || verify_assertion(enrolled, &challenge, assertion).is_err()
                {
                    return Err("invalid_assertion");
                }
                let authenticated_at = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|_| "unavailable")?
                    .as_secs();
                let principal = Principal {
                    id: "fixture-owner",
                    method: "webauthn",
                    session_id: B64.encode(self.id),
                    authenticated_at,
                };
                let response = json!({"principal": principal});
                self.principal = Some(principal);
                Ok(response)
            }
            cmd => fake_command(self.principal.as_ref(), cmd),
        }
    }

    fn response(
        &mut self,
        request: &[u8],
        enrolled: &Enrollment,
        connection: &Connection,
    ) -> Value {
        let Ok(request) = serde_json::from_slice::<Request>(request) else {
            return error(None, "bad_frame");
        };
        let id = Some(request.id);
        if request.v != 1 || request.id == 0 {
            return error(id, "bad_envelope");
        }
        if self.seen.contains(&request.id) {
            return error(id, "duplicate_request");
        }
        if self.seen.len() >= MAX_REQUESTS {
            return error(id, "session_limit");
        }
        self.seen.insert(request.id);
        match self.dispatch(request.body, enrolled, connection) {
            Ok(result) => json!({"v": 1, "id": id, "ok": true, "result": result}),
            Err(code) => error(id, code),
        }
    }
}

fn error(id: Option<u32>, code: &str) -> Value {
    json!({"v": 1, "id": id, "ok": false, "error": code})
}

async fn serve(connection: Connection, owner: EndpointId, enrolled: Arc<Enrollment>) -> Result<()> {
    let peer = connection.remote_id();
    timeout(STREAM_TIMEOUT, async {
        loop {
            if let Some(path) = connection.paths().iter().find(|path| path.is_selected()) {
                ensure!(path.is_relay() && !path.is_ip(), "non-relay path selected");
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await??;
    println!("{}", json!({"path": "relay", "peer": peer.to_string()}));
    let mut session = Session {
        id: random_32()?,
        peer,
        owner,
        challenge: None,
        principal: None,
        seen: HashSet::new(),
    };
    let _ = timeout(SESSION_TIMEOUT, async {
        while let Ok((mut send, mut recv)) = connection.accept_bi().await {
            timeout(STREAM_TIMEOUT, async {
                let result = match read_frame(&mut recv).await? {
                    Some(frame) => session.response(&frame, &enrolled, &connection),
                    None => error(None, "frame_too_large"),
                };
                let bytes = serde_json::to_vec(&result)?;
                ensure!(bytes.len() <= MAX_FRAME, "response cap");
                send.write_all(&bytes).await?;
                send.finish()?;
                Ok::<_, anyhow::Error>(())
            })
            .await??;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await;
    connection.close(1u32.into(), b"session ended");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    // Only the synthetic public enrollment is supplied by the local browser runner.
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let enrolled: Enrollment =
        serde_json::from_str(&lines.next_line().await?.context("missing enrollment")?)?;
    let port = enrolled
        .origin
        .strip_prefix("http://localhost:")
        .context("fixture origin must be loopback")?;
    ensure!(port.parse::<u16>()? != 0, "invalid port");
    let enrolled = Arc::new(enrolled);
    let mut relay_config = ServerConfig::default();
    relay_config.relay = Some(RelayConfig::new(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))));
    let relay = Server::spawn(relay_config).await?;
    let address = relay.http_addr().context("loopback relay failed to bind")?;
    ensure!(address.ip().is_loopback(), "relay must be loopback");
    let relay_url: RelayUrl = format!("http://{address}/").parse()?;
    let owner = relay_only(relay_url.clone())
        .alpns(vec![ALPN.to_vec()])
        .transport_config(
            QuicTransportConfig::builder()
                .max_concurrent_bidi_streams(1u32.into())
                .max_concurrent_uni_streams(0u32.into())
                .build(),
        )
        .bind()
        .await?;
    timeout(STREAM_TIMEOUT, owner.online()).await?;
    ensure!(
        owner.addr().ip_addrs().next().is_none(),
        "unexpected IP address"
    );
    let owner_id = owner.id();
    println!(
        "{}",
        json!({"ready": true, "owner": owner_id.to_string(), "relay": relay_url.to_string(), "ownerIpAddresses": 0})
    );
    let mut relay = Some(relay);
    let mut sessions = JoinSet::new();
    loop {
        tokio::select! {
            incoming = owner.accept() => {
                let Some(incoming) = incoming else { break };
                if sessions.len() >= 4 {
                    incoming.refuse();
                    continue;
                }
                let enrolled = enrolled.clone();
                sessions.spawn(async move {
                    match timeout(STREAM_TIMEOUT, incoming).await {
                        Ok(Ok(connection)) => serve(connection, owner_id, enrolled).await,
                        _ => Ok(()),
                    }
                });
            }
            outcome = sessions.join_next(), if !sessions.is_empty() => {
                if let Some(Ok(Err(error))) = outcome { eprintln!("session ended: {error}"); }
            }
            command = lines.next_line() => match command?.as_deref() {
                Some("stop-relay") => {
                    relay.take().context("relay already stopped")?.shutdown().await?;
                    println!("{}", json!({"relayStopped": true}));
                }
                None | Some("exit") => break,
                _ => anyhow::bail!("unknown harness control"),
            }
        }
    }
    owner.close().await;
    Ok(())
}
