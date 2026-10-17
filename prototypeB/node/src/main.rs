mod crypto;
mod p2p;
mod records;
mod storage;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::StatusCode,
    response::{Html, IntoResponse},
    routing::{get, post},
    Json, Router,
};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
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
}

/// Fan out an event JSON string to all connected browser clients.
fn emit(state: &AppState, event: serde_json::Value) {
    let _ = state.events.send(event.to_string());
}

#[derive(Serialize, Deserialize)]
struct PeerAdd {
    url: String,
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
        .route("/api/blob", post(upload_blob).get(list_blobs))
        .route("/api/blob/:cid", get(get_blob))
        .route("/api/record", post(upload_record))
        .route("/api/record/sign", post(sign_record))
        .route("/api/record/:id", get(get_record))
        .route("/api/records", get(list_records))
        .route("/api/wall", get(get_wall))
        .route("/api/dm", get(get_dm))
        .route("/api/peers", post(add_peer).get(list_peers))
        .route("/api/sync", post(sync))
        .route("/api/identity", get(get_identity))
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

async fn upload_blob(
    State(state): State<Arc<AppState>>,
    bytes: axum::body::Bytes,
) -> impl IntoResponse {
    let cid = match state.store.put(&bytes) {
        Ok(cid) => cid,
        Err(e) => {
            warn!("failed to store blob: {}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "storage failed"})));
        }
    };
    (StatusCode::CREATED, Json(json!({ "cid": cid })))
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
        .filter(|r| matches!(r.r#type, records::RecordType::Post))
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
