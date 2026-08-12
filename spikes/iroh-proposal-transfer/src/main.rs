use std::{
    io::ErrorKind,
    net::Ipv4Addr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use iroh::{
    Endpoint, EndpointAddr, RelayMode, SecretKey, TransportAddr,
    endpoint::{Connection, presets},
    protocol::{AcceptError, ProtocolHandler, Router},
    tls::CaTlsConfig,
};
use serde::{Deserialize, Serialize};
use tokio::{
    fs::{self, OpenOptions},
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    time::{sleep, timeout},
};

const ALPN: &[u8] = b"cyberbaser/fixture/proposal-transfer/1";
const PROTOCOL_VERSION: u8 = 1;
const MAX_PROPOSAL_BYTES: usize = 256 * 1024;
const MAX_JSON_BYTES: usize = 4096;
const CHUNK_BYTES: usize = 1024;
const INTERRUPT_CHUNKS: usize = 4;
const PATH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FixtureInput {
    proposal_base64: String,
    work_dir: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FixtureOutput {
    schema_version: u8,
    artifact_type: &'static str,
    protocol: &'static str,
    chunk_bytes: usize,
    transport_hash: String,
    proposal_byte_length: usize,
    sender_endpoint_id: String,
    receiver_endpoint_id: String,
    direct: TransferEvidence,
    relay: RelayEvidence,
    files: OutputFiles,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputFiles {
    direct: &'static str,
    relay: &'static str,
    interrupted_prefix: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferEvidence {
    selected_path: &'static str,
    started_at_offset: u64,
    completed_at_offset: u64,
    content_bytes_transferred: u64,
    chunks_acknowledged: usize,
    status: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayEvidence {
    interrupted: TransferEvidence,
    continued: TransferEvidence,
    duplicate: TransferEvidence,
    same_content_identity: bool,
    resumed_from_acknowledged_offset: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TransferRequest {
    version: u8,
    transport_hash: String,
    total_length: u64,
    offset: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TransferResponse {
    version: u8,
    status: String,
    transport_hash: String,
    total_length: u64,
    offset: u64,
}

#[derive(Debug, Clone)]
struct ProposalProtocol {
    data: Arc<Vec<u8>>,
    transport_hash: String,
}

impl ProposalProtocol {
    async fn handle(&self, connection: Connection) -> Result<()> {
        let (mut send, mut recv) = connection.accept_bi().await?;
        let request: TransferRequest = read_json(&mut recv).await?;
        validate_request(&request, &self.data, &self.transport_hash)?;

        let status = if request.offset == request.total_length {
            "already-present"
        } else {
            "ready"
        };
        write_json(
            &mut send,
            &TransferResponse {
                version: PROTOCOL_VERSION,
                status: status.to_owned(),
                transport_hash: self.transport_hash.clone(),
                total_length: self.data.len() as u64,
                offset: request.offset,
            },
        )
        .await?;
        let response_ack = recv.read_u8().await?;
        ensure!(
            response_ack == 1,
            "receiver did not acknowledge the transfer response"
        );

        if status == "already-present" {
            send.finish()?;
            return Ok(());
        }

        let mut offset = request.offset as usize;
        while offset < self.data.len() {
            let end = (offset + CHUNK_BYTES).min(self.data.len());
            send.write_all(&(offset as u64).to_be_bytes()).await?;
            send.write_all(&((end - offset) as u32).to_be_bytes())
                .await?;
            send.write_all(&self.data[offset..end]).await?;
            send.flush().await?;

            let acknowledged = recv.read_u64().await?;
            ensure!(
                acknowledged == end as u64,
                "receiver acknowledged an unexpected offset"
            );
            offset = end;
        }
        send.finish()?;
        Ok(())
    }
}

impl ProtocolHandler for ProposalProtocol {
    async fn accept(&self, connection: Connection) -> Result<(), AcceptError> {
        self.handle(connection)
            .await
            .map_err(|error| AcceptError::from_err(std::io::Error::other(error.to_string())))
    }
}

#[derive(Debug, Clone, Copy)]
enum Route {
    Direct,
    Relay,
}

impl Route {
    fn label(self) -> &'static str {
        match self {
            Self::Direct => "ip",
            Self::Relay => "relay",
        }
    }
}

async fn write_json<W: AsyncWrite + Unpin, T: Serialize>(writer: &mut W, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    ensure!(
        bytes.len() <= MAX_JSON_BYTES,
        "protocol JSON frame is too large"
    );
    writer
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .await?;
    writer.write_all(&bytes).await?;
    writer.flush().await?;
    Ok(())
}

async fn read_json<R: AsyncRead + Unpin, T: for<'de> Deserialize<'de>>(
    reader: &mut R,
) -> Result<T> {
    let length = reader.read_u32().await? as usize;
    ensure!(
        length > 0 && length <= MAX_JSON_BYTES,
        "invalid protocol JSON frame length"
    );
    let mut bytes = vec![0u8; length];
    reader.read_exact(&mut bytes).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn validate_request(request: &TransferRequest, data: &[u8], expected_hash: &str) -> Result<()> {
    ensure!(
        request.version == PROTOCOL_VERSION,
        "unsupported protocol version"
    );
    ensure!(
        request.transport_hash == expected_hash,
        "transport hash mismatch"
    );
    ensure!(
        request.total_length == data.len() as u64,
        "proposal length mismatch"
    );
    ensure!(
        request.offset <= request.total_length,
        "resume offset exceeds proposal length"
    );
    ensure!(
        (request.offset as usize).is_multiple_of(CHUNK_BYTES)
            || request.offset == request.total_length,
        "resume offset is not an acknowledged chunk boundary"
    );
    Ok(())
}

fn fixed_secret(byte: u8) -> SecretKey {
    SecretKey::from_bytes(&[byte; 32])
}

async fn selected_path(connection: &Connection, expected: Route) -> Result<&'static str> {
    timeout(PATH_TIMEOUT, async {
        loop {
            if let Some(path) = connection.paths().iter().find(|path| path.is_selected()) {
                match expected {
                    Route::Direct => ensure!(
                        path.is_ip() && !path.is_relay(),
                        "selected path was not direct IP"
                    ),
                    Route::Relay => ensure!(
                        path.is_relay() && !path.is_ip(),
                        "selected path was not relay-only"
                    ),
                }
                return Ok(expected.label());
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .context("timed out waiting for a selected Iroh path")?
}

fn validate_partial(path: &Path, data: &[u8]) -> Result<u64> {
    match std::fs::read(path) {
        Ok(bytes) => {
            ensure!(
                bytes.len() <= data.len(),
                "partial proposal exceeds expected length"
            );
            ensure!(
                bytes == data[..bytes.len()],
                "partial proposal bytes do not match the content identity"
            );
            ensure!(
                bytes.len() % CHUNK_BYTES == 0 || bytes.len() == data.len(),
                "partial proposal ends outside an acknowledged chunk boundary"
            );
            Ok(bytes.len() as u64)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error.into()),
    }
}

async fn receive(
    endpoint: &Endpoint,
    target: EndpointAddr,
    route: Route,
    data: &[u8],
    transport_hash: &str,
    output: &Path,
    stop_after_chunks: Option<usize>,
) -> Result<TransferEvidence> {
    let start = validate_partial(output, data)?;
    let connection = endpoint.connect(target, ALPN).await?;
    let selected = selected_path(&connection, route).await?;
    let (mut send, mut recv) = connection.open_bi().await?;
    write_json(
        &mut send,
        &TransferRequest {
            version: PROTOCOL_VERSION,
            transport_hash: transport_hash.to_owned(),
            total_length: data.len() as u64,
            offset: start,
        },
    )
    .await?;
    let response: TransferResponse = read_json(&mut recv).await?;
    ensure!(
        response.version == PROTOCOL_VERSION,
        "server returned an unsupported version"
    );
    ensure!(
        response.transport_hash == transport_hash,
        "server returned the wrong content identity"
    );
    ensure!(
        response.total_length == data.len() as u64,
        "server returned the wrong total length"
    );
    ensure!(
        response.offset == start,
        "server returned the wrong resume offset"
    );
    send.write_u8(1).await?;
    send.flush().await?;

    if response.status == "already-present" {
        ensure!(
            start == data.len() as u64,
            "server claimed already-present for incomplete content"
        );
        return Ok(TransferEvidence {
            selected_path: selected,
            started_at_offset: start,
            completed_at_offset: start,
            content_bytes_transferred: 0,
            chunks_acknowledged: 0,
            status: "already-present",
        });
    }
    ensure!(
        response.status == "ready",
        "server returned an unknown transfer status"
    );

    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).await?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(output)
        .await?;
    let mut offset = start;
    let mut chunks = 0usize;
    loop {
        if offset == data.len() as u64 {
            break;
        }
        let chunk_offset = recv.read_u64().await?;
        let chunk_length = recv.read_u32().await? as usize;
        ensure!(chunk_offset == offset, "received a non-contiguous chunk");
        ensure!(
            chunk_length > 0 && chunk_length <= CHUNK_BYTES,
            "received an invalid chunk length"
        );
        ensure!(
            chunk_offset as usize + chunk_length <= data.len(),
            "chunk exceeds the proposal length"
        );
        let mut chunk = vec![0u8; chunk_length];
        recv.read_exact(&mut chunk).await?;
        ensure!(
            chunk == data[chunk_offset as usize..chunk_offset as usize + chunk_length],
            "received bytes do not match the content identity"
        );
        file.write_all(&chunk).await?;
        file.sync_data().await?;
        offset += chunk_length as u64;
        send.write_all(&offset.to_be_bytes()).await?;
        send.flush().await?;
        chunks += 1;

        if stop_after_chunks == Some(chunks) {
            drop(file);
            drop(send);
            drop(recv);
            drop(connection);
            return Ok(TransferEvidence {
                selected_path: selected,
                started_at_offset: start,
                completed_at_offset: offset,
                content_bytes_transferred: offset - start,
                chunks_acknowledged: chunks,
                status: "interrupted",
            });
        }
    }
    file.sync_all().await?;
    let completed = fs::read(output).await?;
    ensure!(
        completed == data,
        "completed proposal bytes differ from the sender bytes"
    );
    ensure!(
        blake3::hash(&completed).to_hex().as_str() == transport_hash,
        "completed proposal hash mismatch"
    );
    Ok(TransferEvidence {
        selected_path: selected,
        started_at_offset: start,
        completed_at_offset: offset,
        content_bytes_transferred: offset - start,
        chunks_acknowledged: chunks,
        status: "complete",
    })
}

async fn direct_transfer(
    data: Arc<Vec<u8>>,
    hash: String,
    output: &Path,
) -> Result<TransferEvidence> {
    let sender = Endpoint::builder(presets::Minimal)
        .secret_key(fixed_secret(11))
        .relay_mode(RelayMode::Disabled)
        .clear_relay_transports()
        .clear_address_lookup()
        .clear_ip_transports()
        .bind_addr((Ipv4Addr::LOCALHOST, 0))?
        .bind()
        .await?;
    let router = Router::builder(sender.clone())
        .accept(
            ALPN,
            ProposalProtocol {
                data: data.clone(),
                transport_hash: hash.clone(),
            },
        )
        .spawn();
    let socket = sender
        .bound_sockets()
        .into_iter()
        .find(|address| address.is_ipv4())
        .context("direct sender did not bind IPv4")?;
    let target = EndpointAddr::from_parts(sender.id(), [TransportAddr::Ip(socket)]);
    let receiver = Endpoint::builder(presets::Minimal)
        .secret_key(fixed_secret(12))
        .relay_mode(RelayMode::Disabled)
        .clear_relay_transports()
        .clear_address_lookup()
        .clear_ip_transports()
        .bind_addr((Ipv4Addr::LOCALHOST, 0))?
        .bind()
        .await?;
    let result = receive(&receiver, target, Route::Direct, &data, &hash, output, None).await;
    receiver.close().await;
    router.shutdown().await?;
    result
}

async fn relay_endpoint(secret: SecretKey, relay_map: iroh::RelayMap) -> Result<Endpoint> {
    Ok(Endpoint::builder(presets::Minimal)
        .secret_key(secret)
        .relay_mode(RelayMode::Custom(relay_map))
        .ca_tls_config(CaTlsConfig::insecure_skip_verify())
        .clear_address_lookup()
        .clear_ip_transports()
        .bind()
        .await?)
}

async fn relay_phase(
    data: Arc<Vec<u8>>,
    hash: String,
    output: &Path,
    relay_map: iroh::RelayMap,
    relay_url: iroh::RelayUrl,
    stop_after_chunks: Option<usize>,
) -> Result<TransferEvidence> {
    let sender = relay_endpoint(fixed_secret(11), relay_map.clone()).await?;
    let router = Router::builder(sender.clone())
        .accept(
            ALPN,
            ProposalProtocol {
                data: data.clone(),
                transport_hash: hash.clone(),
            },
        )
        .spawn();
    sender.online().await;
    let target = EndpointAddr::new(sender.id()).with_relay_url(relay_url);
    let receiver = relay_endpoint(fixed_secret(12), relay_map).await?;
    receiver.online().await;
    let result = receive(
        &receiver,
        target,
        Route::Relay,
        &data,
        &hash,
        output,
        stop_after_chunks,
    )
    .await;
    receiver.close().await;
    router.shutdown().await?;
    result
}

async fn run(input: FixtureInput) -> Result<FixtureOutput> {
    use base64::Engine as _;

    ensure!(input.work_dir.is_absolute(), "workDir must be absolute");
    let data = base64::engine::general_purpose::STANDARD
        .decode(input.proposal_base64)
        .context("proposalBase64 is invalid")?;
    ensure!(
        !data.is_empty() && data.len() <= MAX_PROPOSAL_BYTES,
        "proposal bytes are outside the canonical size bound"
    );
    ensure!(
        data.len() > CHUNK_BYTES * INTERRUPT_CHUNKS,
        "proposal is too small for deterministic interruption"
    );
    let transport_hash = blake3::hash(&data).to_hex().to_string();

    fs::create_dir_all(&input.work_dir).await?;
    let direct_path = input.work_dir.join("direct-proposal.json");
    let relay_path = input.work_dir.join("relay-proposal.json");
    let interrupted_path = input.work_dir.join("interrupted-prefix.bin");
    for path in [&direct_path, &relay_path, &interrupted_path] {
        match fs::remove_file(path).await {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }

    let data = Arc::new(data);
    let direct = direct_transfer(data.clone(), transport_hash.clone(), &direct_path)
        .await
        .context("direct transfer failed")?;

    let (relay_map, relay_url, relay_server) = iroh::test_utils::run_relay_server().await?;
    let interrupted = relay_phase(
        data.clone(),
        transport_hash.clone(),
        &interrupted_path,
        relay_map.clone(),
        relay_url.clone(),
        Some(INTERRUPT_CHUNKS),
    )
    .await
    .context("relay interruption phase failed")?;
    ensure!(
        interrupted.completed_at_offset == (CHUNK_BYTES * INTERRUPT_CHUNKS) as u64,
        "interruption did not stop at the deterministic boundary"
    );
    fs::copy(&interrupted_path, &relay_path).await?;
    let continued = relay_phase(
        data.clone(),
        transport_hash.clone(),
        &relay_path,
        relay_map.clone(),
        relay_url.clone(),
        None,
    )
    .await
    .context("relay continuation phase failed")?;
    let duplicate = relay_phase(
        data.clone(),
        transport_hash.clone(),
        &relay_path,
        relay_map,
        relay_url,
        None,
    )
    .await
    .context("relay duplicate phase failed")?;
    drop(relay_server);

    ensure!(
        fs::read(&direct_path).await? == *data,
        "direct output mismatch"
    );
    ensure!(
        fs::read(&relay_path).await? == *data,
        "relay output mismatch"
    );

    Ok(FixtureOutput {
        schema_version: 1,
        artifact_type: "cyberbaser-iroh-transport-receipt",
        protocol: "cyberbaser/fixture/proposal-transfer/1",
        chunk_bytes: CHUNK_BYTES,
        transport_hash,
        proposal_byte_length: data.len(),
        sender_endpoint_id: fixed_secret(11).public().to_string(),
        receiver_endpoint_id: fixed_secret(12).public().to_string(),
        relay: RelayEvidence {
            same_content_identity: true,
            resumed_from_acknowledged_offset: continued.started_at_offset
                == interrupted.completed_at_offset,
            interrupted,
            continued,
            duplicate,
        },
        direct,
        files: OutputFiles {
            direct: "direct-proposal.json",
            relay: "relay-proposal.json",
            interrupted_prefix: "interrupted-prefix.bin",
        },
    })
}

#[tokio::main]
async fn main() {
    let result = async {
        let input: FixtureInput =
            serde_json::from_reader(std::io::stdin()).context("invalid fixture input JSON")?;
        let output = run(input).await?;
        serde_json::to_writer(std::io::stdout(), &output)?;
        println!();
        Ok::<(), anyhow::Error>(())
    }
    .await;

    if let Err(error) = result {
        eprintln!("iroh fixture failed: {error:#}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data() -> Vec<u8> {
        vec![7u8; CHUNK_BYTES * 5 + 17]
    }

    #[test]
    fn validates_only_bound_chunk_offsets() {
        let data = data();
        let hash = blake3::hash(&data).to_hex().to_string();
        let valid = TransferRequest {
            version: 1,
            transport_hash: hash.clone(),
            total_length: data.len() as u64,
            offset: CHUNK_BYTES as u64,
        };
        validate_request(&valid, &data, &hash).unwrap();
        let invalid = TransferRequest { offset: 1, ..valid };
        assert!(validate_request(&invalid, &data, &hash).is_err());
    }

    #[test]
    fn rejects_wrong_hash_length_and_version() {
        let data = data();
        let hash = blake3::hash(&data).to_hex().to_string();
        let base = TransferRequest {
            version: 1,
            transport_hash: hash.clone(),
            total_length: data.len() as u64,
            offset: 0,
        };
        assert!(
            validate_request(
                &TransferRequest {
                    version: 2,
                    ..base.clone()
                },
                &data,
                &hash
            )
            .is_err()
        );
        assert!(
            validate_request(
                &TransferRequest {
                    transport_hash: "0".repeat(64),
                    ..base.clone()
                },
                &data,
                &hash
            )
            .is_err()
        );
        assert!(
            validate_request(
                &TransferRequest {
                    total_length: 1,
                    ..base
                },
                &data,
                &hash
            )
            .is_err()
        );
    }

    #[test]
    fn validates_partial_prefix_and_rejects_tampering() {
        let root = std::env::temp_dir().join(format!("cb-iroh-partial-{}", std::process::id()));
        let _ = std::fs::remove_file(&root);
        let data = data();
        std::fs::write(&root, &data[..CHUNK_BYTES]).unwrap();
        assert_eq!(validate_partial(&root, &data).unwrap(), CHUNK_BYTES as u64);
        std::fs::write(&root, vec![9u8; CHUNK_BYTES]).unwrap();
        assert!(validate_partial(&root, &data).is_err());
        let _ = std::fs::remove_file(&root);
    }
}
