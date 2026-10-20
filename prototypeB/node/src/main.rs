#![allow(dead_code)]

mod crypto;
mod p2p;
mod records;
mod storage;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State, DefaultBodyLimit,
    },
    http::StatusCode,
    response::{Html, IntoResponse},
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tower_http::services::ServeDir;
use tower_http::cors::{Any, CorsLayer};
use tracing::{info, warn};

struct AppState {
    store: Arc<storage::ContentAddressedStore>,
    keypair: Arc<crypto::Keypair>,
    pub_key: String,
    peers: Arc<RwLock<Vec<String>>>,
    known_records: Arc<RwLock<HashMap<String, records::BaseRecord>>>,
    p2p: Option<Arc<p2p::P2PHandle>>,
    events: broadcast::Sender<String>,
    connected_peers: Arc<RwLock<HashMap<String, Vec<String>>>>,
}/// Fan out an event JSON string to all connected browser clients.
fn emit(state: &AppState, event: serde_json::Value) {
    let _ = state.events.send(event.to_string());
}

/// Check whether a CID is in the node's blocked set (nuke actions by trusted mods).
async fn is_cid_blocked(state: &AppState, cid: &str) -> bool {
    let known = state.known_records.read().await;
    let (blocked, _, _) = compute_moderation_sets(&known, &state.pub_key);
    blocked.contains(cid)
}

/// Check whether a CID is hidden by moderation (hide actions by trusted mods).
async fn is_cid_hidden(state: &AppState, cid: &str) -> bool {
    let known = state.known_records.read().await;
    let (_, hidden, _) = compute_moderation_sets(&known, &state.pub_key);
    hidden.contains(cid)
}

#[derive(Serialize, Deserialize)]
struct PeerAdd {
    url: String,
}

#[derive(Deserialize)]
struct ReportRequest {
    target_cid: String,
    reason: String,
}

#[derive(Serialize, Deserialize)]
struct SyncResponse {
    added: usize,
}

#[derive(Serialize, Deserialize)]
struct WallResponse {
    posts: Vec<records::BaseRecord>,
}

#[derive(Serialize, Deserialize)]
struct RecordListEntry {
    id: String,
    r#type: String,
    author: String,
    ts: u64,
}

#[derive(Serialize, Deserialize)]
struct RecordListResponse {
    records: Vec<RecordListEntry>,
}

#[derive(Serialize, Deserialize)]
struct DmResponse {
    messages: Vec<records::BaseRecord>,
}

#[derive(Deserialize)]
struct QueryParams {
    me: Option<String>,
    other: Option<String>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let data_dir = std::env::var("DDN_DATA_DIR").unwrap_or_else(|_| "./data".to_string());
    let data_path = PathBuf::from(&data_dir);
    std::fs::create_dir_all(&data_path)?;

    let store = Arc::new(storage::ContentAddressedStore::new(&data_path));
    let keypair = Arc::new(crypto::Keypair::generate());
    let pub_key = crypto::pubkey_to_cid(&keypair.public_key_bytes());

    info!("Node public key (author): {}", pub_key);
    info!("Data directory: {}", data_dir);

    // --- libp2p swarm (Phase 1) --------------------------------------------
    let p2p_port: u16 = std::env::var("DDN_P2P_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(4001);
    let bootstrap_peers: Vec<String> = std::env::var("DDN_BOOTSTRAP_PEERS")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let (events_tx, _events_rx0) = broadcast::channel::<String>(256);
    let connected_peers: Arc<RwLock<HashMap<String, Vec<String>>>> =
        Arc::new(RwLock::new(HashMap::new()));

    let p2p_handle = match p2p::spawn_swarm(&keypair.secret_bytes(), p2p_port, bootstrap_peers).await {
        Ok(h) => Some(Arc::new(h)),
        Err(e) => {
            warn!("libp2p swarm failed to start (falling back to HTTP sync only): {}", e);
            None
        }
    };

    let state = Arc::new(AppState {
        store,
        keypair,
        pub_key,
        peers: Arc::new(RwLock::new(Vec::new())),
        known_records: Arc::new(RwLock::new(HashMap::new())),
        p2p: p2p_handle.clone(),
        events: events_tx,
        connected_peers: connected_peers.clone(),
    });

    // --- gossip consumer task: verify -> store -> broadcast to browsers ----
    if let Some(handle) = p2p_handle {
        let consumer_state = state.clone();
        let handle_clone = handle.clone();
        tokio::spawn(async move {
            let mut rx = handle.events.lock().await;
            while let Some(ev) = rx.recv().await {
                let record: records::BaseRecord = match serde_json::from_slice(&ev.data) {
                    Ok(r) => r,
                    Err(_) => continue, // not a canonical record — drop
                };
                if record.verify().is_err() {
                    warn!("dropping gossip record with bad signature: {}", record.id);
                    continue;
                }
                let is_new = {
                    let mut known = consumer_state.known_records.write().await;
                    if known.contains_key(&record.id) {
                        false
                    } else {
                        let canonical = record.to_canonical_json().unwrap_or_default();
                        consumer_state.store.put_record(&record.id, canonical.as_bytes()).ok();
                        known.insert(record.id.clone(), record.clone());
                        true
                    }
                };
                if is_new {
                    emit(&consumer_state, json!({
                        "type": "gossip",
                        "source": ev.source,
                        "record": &record,
                    }));
                }
            }
        });

        // --- signal consumer task: relay WebRTC signaling to browser via WS --
        let signal_state = state.clone();
        tokio::spawn(async move {
            let mut rx = handle_clone.signal_events.lock().await;
            while let Some(ev) = rx.recv().await {
                // Forward the signaling payload to all connected browsers.
                // The browser filters by `target` pubkey.
                emit(&signal_state, json!({
                    "type": "webrtc_signal",
                    "source": ev.source,
                    "data": base64::engine::general_purpose::STANDARD.encode(&ev.data),
                }));
            }
        });
    }

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let frontend_path = std::env::var("DDN_FRONTEND_PATH").unwrap_or_else(|_| {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let candidate = PathBuf::from(manifest_dir).join("../frontend");
        if candidate.join("dist/index.html").exists() {
            candidate.join("dist").to_string_lossy().to_string()
        } else if candidate.join("index.html").exists() {
            candidate.to_string_lossy().to_string()
        } else {
            "./frontend".to_string()
        }
    });

    let app = Router::new()
        .route("/api/blob", post(upload_blob).get(list_blobs).layer(DefaultBodyLimit::max(MAX_BLOB_SIZE as usize)))
        .route("/api/blob/:cid", get(get_blob))
        .route("/api/record", post(upload_record))
        .route("/api/record/sign", post(sign_record))
        .route("/api/record/:id", get(get_record))
        .route("/api/records", get(list_records))
        .route("/api/wall", get(get_wall))
        .route("/api/dm", get(get_dm))
        .route("/api/dm/seal", post(seal_dm_endpoint))
        .route("/api/dm/open", post(open_dm_endpoint))
        .route("/api/media/offer", post(media_offer_endpoint))
        .route("/api/media/accept", post(media_accept_endpoint))
        .route("/api/media/keypair", post(generate_keypair_endpoint))
        .route("/api/webrtc/signal", post(webrtc_signal))
        .route("/api/report", post(create_report_endpoint))
        .route("/api/moderation", get(moderation_status))
        .route("/api/peers", post(add_peer).get(list_peers))
        .route("/api/sync", post(sync))
        .route("/api/identity", get(get_identity))
        .route("/api/identity/backup", post(backup_identity))
        .route("/api/identity/restore", post(restore_identity))
        .route("/api/network", get(network_status))
        .route("/api/network/connect", post(network_connect))
        .route("/ws/events", get(ws_events))
        .route("/", get(serve_frontend))
        .nest_service("/static", ServeDir::new(&frontend_path))
        .with_state(state)
        .layer(cors);

    let addr = SocketAddr::from(([0, 0, 0, 0], 3000));
    info!("DDN node listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app.into_make_service()).await?;

    Ok(())
}

async fn serve_frontend() -> impl IntoResponse {
    let index_path = std::env::var("DDN_FRONTEND_PATH").unwrap_or_else(|_| {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let candidate = PathBuf::from(manifest_dir).join("../frontend");
        if candidate.join("dist/index.html").exists() {
            candidate.join("dist").to_string_lossy().to_string()
        } else if candidate.join("index.html").exists() {
            candidate.to_string_lossy().to_string()
        } else {
            "./frontend".to_string()
        }
    });
    let path = std::path::PathBuf::from(index_path).join("index.html");
    let html = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| "<html><body><h1>Frontend not found</h1><p>Run <code>npm run build</code> in <code>prototypeB/frontend/</code> first.</p></body></html>".to_string());
    info!("Serving frontend from: {}", path.display());
    Html(html)
}

async fn get_identity(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(json!({
        "pubkey": state.pub_key,
    }))
}

#[derive(Deserialize)]
struct BackupRequest {
    password: String,
}

async fn backup_identity(State(state): State<Arc<AppState>>, body: axum::body::Bytes) -> axum::response::Response {
    let req: BackupRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, Json(json!({"error": format!("invalid request: {}", e)}))).into_response();
        }
    };
    let file = crypto::create_identity_file(&state.keypair, &req.password);
    let json_str = match serde_json::to_string(&file) {
        Ok(s) => s,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("serialization failed: {}", e)}))).into_response();
        }
    };
    axum::response::Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/json")
        .header("Content-Disposition", "attachment; filename=ddn_backup.json")
        .body(axum::body::Body::from(json_str))
        .unwrap()
}

#[derive(Deserialize)]
struct RestoreRequest {
    file: crypto::IdentityFile,
    password: String,
}

async fn restore_identity(body: axum::body::Bytes) -> axum::response::Response {
    let req: RestoreRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, Json(json!({"error": format!("invalid request: {}", e)}))).into_response();
        }
    };
    match crypto::load_identity_file(&req.file, &req.password) {
        Ok(kp) => {
            let file = crypto::create_identity_file(&kp, &req.password);
            let json_str = serde_json::to_string(&file).unwrap_or_default();
            axum::response::Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "application/json")
                .body(axum::body::Body::from(json_str))
                .unwrap()
        }
        Err(e) => {
            (StatusCode::UNAUTHORIZED, Json(json!({"error": e}))).into_response()
        }
    }
}

/// Maximum blob size accepted by CAS upload (5 MB).
/// Files larger than this must use the WebRTC media_offer flow.
const MAX_BLOB_SIZE: u64 = 5 * 1024 * 1024;

async fn upload_blob(
    State(state): State<Arc<AppState>>,
    bytes: axum::body::Bytes,
) -> impl IntoResponse {
    if bytes.len() as u64 > MAX_BLOB_SIZE {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({ "error": format!("blob exceeds max size of {} bytes", MAX_BLOB_SIZE) })),
        );
    }

    // Node-level enforcement: refuse to store blobs that have been nuked.
    let cid = storage::ContentAddressedStore::hash(&bytes);
    if is_cid_blocked(&state, &cid).await {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "blob blocked by moderation (nuke)" })),
        );
    }
    match state.store.put(&bytes) {
        Ok(cid) => (StatusCode::CREATED, Json(json!({ "cid": cid }))),
        Err(e) => {
            warn!("failed to store blob: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "storage failed" })))
        }
    }
}

async fn list_blobs(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let blobs_dir = state.store.base_path.join("blobs");
    let mut cids = Vec::new();
    if blobs_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&blobs_dir) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    cids.push(name.to_string());
                }
            }
        }
    }
    Json(json!({ "blobs": cids }))
}

async fn get_blob(
    State(state): State<Arc<AppState>>,
    Path(cid): Path<String>,
) -> Result<(StatusCode, Vec<u8>), StatusCode> {
    // Node-level enforcement: refuse to serve blobs that have been nuked.
    if is_cid_blocked(&state, &cid).await {
        return Err(StatusCode::FORBIDDEN);
    }
    match state.store.get(&cid) {
        Ok(Some(data)) => Ok((StatusCode::OK, data)),
        Ok(None) => Err(StatusCode::NOT_FOUND),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

async fn upload_record(
    State(state): State<Arc<AppState>>,
    bytes: axum::body::Bytes,
) -> impl IntoResponse {
    let record: records::BaseRecord = match serde_json::from_slice(&bytes) {
        Ok(r) => r,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, Json(json!({"error": format!("invalid record: {}", e)})));
        }
    };

    if let Err(e) = record.verify() {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": format!("verification failed: {}", e)})));
    }

    let id = record.id.clone();

    // Node-level enforcement: refuse to store records that have been nuked.
    if is_cid_blocked(&state, &id).await {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "record blocked by moderation (nuke)"})),
        );
    }

    let canonical = record.to_canonical_json().unwrap_or_default();
    state.store.put_record(&id, canonical.as_bytes()).ok();

    let mut known = state.known_records.write().await;
    known.insert(id.clone(), record.clone());
    drop(known);

    // Propagate to the mesh over gossipsub (Phase 1).
    if let Some(p2p) = &state.p2p {
        p2p.publish_record(canonical.as_bytes().to_vec());
    }
    emit(&state, json!({ "type": "record", "record": &record }));

    (StatusCode::CREATED, Json(json!({ "id": id })))
}

async fn sign_record(
    State(state): State<Arc<AppState>>,
    bytes: axum::body::Bytes,
) -> impl IntoResponse {
    let req: records::SignRequest = match serde_json::from_slice(&bytes) {
        Ok(r) => r,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, Json(json!({"error": format!("invalid request: {}", e)})));
        }
    };
    let record = records::BaseRecord::from_sign_request(&req, &state.keypair);
    (StatusCode::OK, Json(json!({
        "id": record.id,
        "type": serde_json::to_string(&record.r#type).unwrap_or_default().trim_matches('"').to_string(),
        "author": record.author,
        "prev": record.prev,
        "ts": record.ts,
        "payload": record.payload,
        "sig": record.sig,
    })))
}

async fn get_record(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<String, StatusCode> {
    // Node-level enforcement: refuse to serve records that have been nuked.
    if is_cid_blocked(&state, &id).await {
        return Err(StatusCode::FORBIDDEN);
    }
    match state.store.get_record(&id) {
        Ok(Some(data)) => {
            let json_str = String::from_utf8_lossy(&data).to_string();
            Ok(json_str)
        }
        Ok(None) => Err(StatusCode::NOT_FOUND),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

async fn list_records(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let known = state.known_records.read().await;
    let entries: Vec<RecordListEntry> = known
        .values()
        .map(|r| RecordListEntry {
            id: r.id.clone(),
            r#type: serde_json::to_string(&r.r#type).unwrap_or_default().trim_matches('"').to_string(),
            author: r.author.clone(),
            ts: r.ts,
        })
        .collect();
    Json(RecordListResponse { records: entries })
}

async fn get_wall(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let known = state.known_records.read().await;
    let posts: Vec<records::BaseRecord> = known
        .values()
        .filter(|r| matches!(r.r#type, records::RecordType::Post | records::RecordType::MediaOffer | records::RecordType::MediaAccept))
        .cloned()
        .collect();
    Json(WallResponse { posts })
}

async fn get_dm(
    State(state): State<Arc<AppState>>,
    Query(params): Query<QueryParams>,
) -> impl IntoResponse {
    let known = state.known_records.read().await;
    let messages: Vec<records::BaseRecord> = known
        .values()
        .filter(|r| {
            if !matches!(r.r#type, records::RecordType::Message) {
                return false;
            }
            if let Ok(payload) = serde_json::to_value(&r.payload) {
                if let Some(to) = payload.get("to").and_then(|v| v.as_str()) {
                    if let (Some(me), Some(other)) = (&params.me, &params.other) {
                        return (r.author == *me && to == *other) || (r.author == *other && to == *me);
                    }
                }
            }
            false
        })
        .cloned()
        .collect();
    Json(DmResponse { messages })
}

async fn add_peer(
    State(state): State<Arc<AppState>>,
    bytes: axum::body::Bytes,
) -> impl IntoResponse {
    let input: PeerAdd = match serde_json::from_slice(&bytes) {
        Ok(p) => p,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, Json(json!({"error": format!("invalid input: {}", e)})));
        }
    };
    let mut peers = state.peers.write().await;
    if !peers.iter().any(|p| p == &input.url) {
        peers.push(input.url.clone());
    }
    (StatusCode::OK, Json(json!({"added": input.url})))
}

async fn list_peers(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let peers = state.peers.read().await;
    Json(json!({"peers": peers.clone()}))
}

async fn sync(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    // Trigger a libp2p bootstrap round as well (Phase 1); the legacy manual
    // HTTP pull below stays as a fallback transport.
    if let Some(p2p) = &state.p2p {
        p2p.bootstrap();
    }

    let peers = state.peers.read().await.clone();

    let client = reqwest::Client::new();
    let mut added = 0;

    for peer_url in &peers {
        let base_url = peer_url.trim_end_matches('/');
        match client.get(&format!("{}/api/records", base_url)).send().await {
            Ok(resp) => {
                if let Ok(list) = resp.json::<RecordListResponse>().await {
                    let mut known = state.known_records.write().await;
                    for entry in list.records {
                        if known.contains_key(&entry.id) {
                            continue;
                        }
                        match client.get(&format!("{}/api/record/{}", base_url, entry.id)).send().await {
                            Ok(record_resp) => {
                                if let Ok(record_bytes) = record_resp.bytes().await {
                                    if let Ok(record) = serde_json::from_slice::<records::BaseRecord>(&record_bytes) {
                                        if record.id == entry.id && record.verify().is_ok() {
                                            let canonical = record.to_canonical_json().unwrap_or_default();
                                            state.store.put_record(&entry.id, canonical.as_bytes()).ok();
                                            known.insert(entry.id.clone(), record);
                                            added += 1;
                                        }
                                    }
                                }
                            }
                            Err(e) => warn!("failed to fetch record {} from {}: {}", entry.id, peer_url, e),
                        }
                    }
                }
            }
            Err(e) => warn!("failed to sync with peer {}: {}", peer_url, e),
        }
    }
    (StatusCode::OK, Json(SyncResponse { added }))
}

// ---------------------------------------------------------------------------
// Phase 2: E2EE DM encryption & WebRTC media signaling
// ---------------------------------------------------------------------------

/// POST /api/dm/seal — encrypt a DM message with X25519 + AES-GCM.
/// The sender authenticates via their node identity (author pubkey).
/// The node never sees the plaintext beyond this request — it seals and
/// returns only the ciphertext fields for inclusion in a `message` record.
#[derive(Deserialize)]
struct SealDmRequest {
    author: String,
    to: String,
    plaintext: String,
}

#[derive(Serialize, Deserialize)]
struct SealDmResponse {
    ciphertext: String,
    nonce: String,
    ephemeral_pubkey: String,
}

async fn seal_dm_endpoint(
    bytes: axum::body::Bytes,
) -> impl IntoResponse {
    let req: SealDmRequest = match serde_json::from_slice(&bytes) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid request: {}", e) })),
            )
                .into_response();
        }
    };

    let sender_pub = match crypto::cid_to_pubkey(&req.author) {
        Ok(p) => p,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid author pubkey: {}", e) })),
            )
                .into_response();
        }
    };

    match crypto::seal_dm(&sender_pub, &req.to, req.plaintext.as_bytes()) {
        Ok((ciphertext, nonce, eph)) => (
            StatusCode::OK,
            Json(SealDmResponse {
                ciphertext,
                nonce,
                ephemeral_pubkey: eph,
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("encryption failed: {}", e) })),
        )
            .into_response(),
    }
}

/// POST /api/dm/open — decrypt a DM message.
/// The recipient's private key is used server-side (the node holds the DDN
/// identity). The plaintext is only returned to the browser; it is never
/// stored to disk.
#[derive(Deserialize)]
struct OpenDmRequest {
    ciphertext: String,
    nonce: String,
    ephemeral_pubkey: String,
    sender: String,
}

#[derive(Serialize, Deserialize)]
struct OpenDmResponse {
    plaintext: String,
}

async fn open_dm_endpoint(
    State(state): State<Arc<AppState>>,
    bytes: axum::body::Bytes,
) -> impl IntoResponse {
    let req: OpenDmRequest = match serde_json::from_slice(&bytes) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid request: {}", e) })),
            )
                .into_response();
        }
    };

    let sender_pub = match crypto::cid_to_pubkey(&req.sender) {
        Ok(p) => p,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid sender pubkey: {}", e) })),
            )
                .into_response();
        }
    };

    match crypto::open_dm(
        &state.keypair.secret_bytes(),
        &sender_pub,
        &req.ciphertext,
        &req.nonce,
        &req.ephemeral_pubkey,
    ) {
        Ok(plaintext) => (
            StatusCode::OK,
            Json(OpenDmResponse {
                plaintext: String::from_utf8_lossy(&plaintext).to_string(),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("decryption failed: {}", e) })),
        )
            .into_response(),
    }
}

/// POST /api/media/offer — create a `media_offer` record for WebRTC file transfer.
/// The sender provides the recipient pubkey, file metadata, and an ephemeral
/// X25519 pubkey (used to encrypt the WebRTC SDP offer). The node signs and
/// stores the record, returning its CID so it can be shared with the recipient.
#[derive(Deserialize)]
struct MediaOfferRequest {
    to: String,
    file_name: String,
    size_bytes: u64,
    ephemeral_pubkey: String,
}

async fn media_offer_endpoint(
    State(state): State<Arc<AppState>>,
    bytes: axum::body::Bytes,
) -> impl IntoResponse {
    let req: MediaOfferRequest = match serde_json::from_slice(&bytes) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid request: {}", e) })),
            )
                .into_response();
        }
    };

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let sign_req = records::SignRequest {
        r#type: "media_offer".to_string(),
        author: state.pub_key.clone(),
        prev: None,
        ts,
        payload: json!({
            "target_user": req.to,
            "file_name": req.file_name,
            "size_bytes": req.size_bytes,
            "ephemeral_pubkey": req.ephemeral_pubkey,
        }),
    };

    let record = records::BaseRecord::from_sign_request(&sign_req, &state.keypair);
    let id = record.id.clone();
    let canonical = record.to_canonical_json().unwrap_or_default();
    state.store.put_record(&id, canonical.as_bytes()).ok();

    let mut known = state.known_records.write().await;
    known.insert(id.clone(), record.clone());
    drop(known);

    if let Some(p2p) = &state.p2p {
        p2p.publish_record(canonical.as_bytes().to_vec());
    }
    emit(&state, json!({ "type": "record", "record": &record }));

    (StatusCode::CREATED, Json(json!({ "id": id, "record": &record }))).into_response()
}

/// POST /api/media/accept — create a `media_accept` record in response to a
/// media_offer. The recipient provides the offer CID and their ephemeral X25519
/// pubkey. The signed record allows the sender to establish the WebRTC
/// Data Channel.
#[derive(Deserialize)]
struct MediaAcceptRequest {
    offer_cid: String,
    ephemeral_pubkey: String,
}

async fn media_accept_endpoint(
    State(state): State<Arc<AppState>>,
    bytes: axum::body::Bytes,
) -> impl IntoResponse {
    let req: MediaAcceptRequest = match serde_json::from_slice(&bytes) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid request: {}", e) })),
            )
                .into_response();
        }
    };

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let sign_req = records::SignRequest {
        r#type: "media_accept".to_string(),
        author: state.pub_key.clone(),
        prev: None,
        ts,
        payload: json!({
            "offer_cid": req.offer_cid,
            "ephemeral_pubkey": req.ephemeral_pubkey,
        }),
    };

    let record = records::BaseRecord::from_sign_request(&sign_req, &state.keypair);
    let id = record.id.clone();
    let canonical = record.to_canonical_json().unwrap_or_default();
    state.store.put_record(&id, canonical.as_bytes()).ok();

    let mut known = state.known_records.write().await;
    known.insert(id.clone(), record.clone());
    drop(known);

    if let Some(p2p) = &state.p2p {
        p2p.publish_record(canonical.as_bytes().to_vec());
    }
    emit(&state, json!({ "type": "record", "record": &record }));

    (StatusCode::CREATED, Json(json!({ "id": id, "record": &record }))).into_response()
}

/// POST /api/media/keypair — generate an ephemeral X25519 keypair for WebRTC
/// signaling. Returns the pubkey (hex, sent in media_offer) and the secret
/// (hex, for the sender to use during the WebRTC handshake). The secret should
/// be discarded after use.
async fn generate_keypair_endpoint() -> impl IntoResponse {
    let (pubkey_hex, secret_hex) = crypto::generate_x25519_keypair();
    (StatusCode::OK, Json(json!({
        "pubkey": pubkey_hex,
        "secret": secret_hex,
    })))
}

/// POST /api/webrtc/signal — forward a WebRTC signaling payload (SDP offer/answer
/// or ICE candidate) to the peer-to-peer network. The payload is gossipsub'd on
/// the `ddn/webrtc/v1` topic and arrives at all connected browser clients via
/// /ws/events. The browser filters by the `target` field in the JSON payload.
#[derive(Deserialize)]
struct WebrtcSignalRequest {
    /// Base64-encoded signaling payload (JSON with `target`, `sdp`, `candidate`, etc.)
    payload: String,
}

async fn webrtc_signal(
    State(state): State<Arc<AppState>>,
    bytes: axum::body::Bytes,
) -> impl IntoResponse {
    let req: WebrtcSignalRequest = match serde_json::from_slice(&bytes) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid request: {}", e) })),
            )
                .into_response();
        }
    };
    let decoded = match base64::engine::general_purpose::STANDARD.decode(&req.payload) {
        Ok(d) => d,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid base64: {}", e) })),
            )
                .into_response();
        }
    };
    if let Some(p2p) = &state.p2p {
        p2p.publish_signal(decoded.clone());
    }

    emit(&state, json!({
        "type": "webrtc_signal",
        "source": state.pub_key.clone(),
        "data": base64::engine::general_purpose::STANDARD.encode(&decoded),
    }));

    (StatusCode::OK, Json(json!({ "status": "signal sent" }))).into_response()
}

// ---------------------------------------------------------------------------
// Phase 3: Moderation
// ---------------------------------------------------------------------------

/// POST /api/report — publish a `report` record flagging content for review.
#[derive(Serialize, Deserialize)]
struct ReportResponse {
    id: String,
    record: records::BaseRecord,
}

async fn create_report_endpoint(
    State(state): State<Arc<AppState>>,
    bytes: axum::body::Bytes,
) -> impl IntoResponse {
    let req: ReportRequest = match serde_json::from_slice(&bytes) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid request: {}", e) })),
            )
                .into_response();
        }
    };

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let sign_req = records::SignRequest {
        r#type: "report".to_string(),
        author: state.pub_key.clone(),
        prev: None,
        ts,
        payload: json!({
            "target_cid": req.target_cid,
            "reason": req.reason,
        }),
    };

    let record = records::BaseRecord::from_sign_request(&sign_req, &state.keypair);
    let id = record.id.clone();
    let canonical = record.to_canonical_json().unwrap_or_default();
    state.store.put_record(&id, canonical.as_bytes()).ok();

    let mut known = state.known_records.write().await;
    known.insert(id.clone(), record.clone());
    drop(known);

    if let Some(p2p) = &state.p2p {
        p2p.publish_record(canonical.as_bytes().to_vec());
    }
    emit(&state, json!({ "type": "record", "record": &record }));

    (
        StatusCode::CREATED,
        Json(ReportResponse { id, record }),
    )
        .into_response()
}

/// GET /api/moderation — return the list of blocked CIDs and trusted mod
/// pubkeys that the node is enforcing. Blocked CIDs come from verified
/// `mod_action` records with `action: "nuke"`; hidden CIDs come from
/// `action: "hide"`; mod pubkeys come from `mod_grant` records signed by the
/// admin.
#[derive(Serialize, Deserialize)]
struct ModerationResponse {
    blocked_cids: Vec<String>,
    hidden_cids: Vec<String>,
    mod_pubkeys: Vec<String>,
}

/// Compute moderation sets from known records.
/// Returns (blocked_cids, hidden_cids, mod_pubkeys).
fn compute_moderation_sets(
    known: &HashMap<String, records::BaseRecord>,
    admin_key: &str,
) -> (HashSet<String>, HashSet<String>, HashSet<String>) {
    let mut blocked_cids: HashSet<String> = HashSet::new();
    let mut hidden_cids: HashSet<String> = HashSet::new();
    let mut mod_pubkeys: HashSet<String> = HashSet::new();

    // First pass: collect mod pubkeys from mod_grant records.
    for record in known.values() {
        if !matches!(record.r#type, records::RecordType::ModGrant) {
            continue;
        }
        if let Some(payload) = record.payload.as_object() {
            let signed_by = payload
                .get("signed_by")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let new_mod = payload
                .get("new_mod_pubkey")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if signed_by == admin_key && !new_mod.is_empty() && record.verify().is_ok() {
                mod_pubkeys.insert(new_mod.to_string());
            }
        }
    }

    // Second pass: collect blocked and hidden CIDs from mod_action records
    // signed by trusted mods.
    for record in known.values() {
        if !matches!(record.r#type, records::RecordType::ModAction) {
            continue;
        }
        if let Some(payload) = record.payload.as_object() {
            let action = payload
                .get("action")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let mod_pk = payload
                .get("mod_pubkey")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let target = payload
                .get("target_cid")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if mod_pubkeys.contains(mod_pk) && !target.is_empty() {
                if action == "nuke" {
                    blocked_cids.insert(target.to_string());
                } else if action == "hide" {
                    hidden_cids.insert(target.to_string());
                }
            }
        }
    }

    (blocked_cids, hidden_cids, mod_pubkeys)
}

async fn moderation_status(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let known = state.known_records.read().await;
    let (blocked, hidden, mods) = compute_moderation_sets(&known, &state.pub_key);
    Json(ModerationResponse {
        blocked_cids: blocked.into_iter().collect(),
        hidden_cids: hidden.into_iter().collect(),
        mod_pubkeys: mods.into_iter().collect(),
    })
}

// ---------------------------------------------------------------------------
// Phase 1: network status + WebSocket event stream for browser clients
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ConnectQuery {
    addr: String,
}

/// GET /api/network — libp2p swarm status.
/// POST /api/network/connect?addr=/ip4/.../tcp/.../p2p/... — dial a peer.
async fn network_status(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match &state.p2p {
        Some(h) => {
            let peers = state.connected_peers.read().await;
            Json(json!({
                "enabled": true,
                "peer_id": h.local_peer_id.to_string(),
                "listen_addrs": h.listen_addrs,
                "topic": p2p::RECORDS_TOPIC,
                "connected_peers": peers.keys().collect::<Vec<_>>(),
                "manual_peers": state.peers.read().await.clone(),
            }))
        }
        None => Json(json!({
            "enabled": false,
            "reason": "libp2p swarm not running (HTTP sync fallback only)",
            "manual_peers": state.peers.read().await.clone(),
        })),
    }
}

async fn network_connect(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ConnectQuery>,
) -> impl IntoResponse {
    match state.p2p.as_ref() {
        Some(h) => match q.addr.parse::<libp2p::Multiaddr>() {
            Ok(addr) => {
                h.connect(addr);
                (StatusCode::OK, Json(json!({ "dialing": q.addr })))
            }
            Err(e) => (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid multiaddr: {}", e) })),
            ),
        },
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "libp2p swarm not running" })),
        ),
    }
}

/// GET /ws/events (upgraded) — push channel for browsers: gossip records,
/// locally created records and peer connect/disconnect notifications.
async fn ws_events(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

async fn handle_ws(mut socket: WebSocket, state: Arc<AppState>) {
    let mut rx = state.events.subscribe();
    // Welcome message so the client knows the stream is live.
    let welcome = json!({
        "type": "hello",
        "pubkey": state.pub_key,
        "peer_id": state.p2p.as_ref().map(|h| h.local_peer_id.to_string()),
    });
    if socket.send(Message::Text(welcome.to_string())).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(msg) => {
                    if socket.send(Message::Text(msg)).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(_)) => break,
                _ => {} // ignore client pings/text
            }
        }
    }
}
