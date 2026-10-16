mod crypto;
mod p2p;
mod records;
mod storage;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{Html, IntoResponse},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::services::ServeDir;
use tower_http::cors::{Any, CorsLayer};
use tracing::{info, warn};

struct AppState {
    store: Arc<storage::ContentAddressedStore>,
    keypair: Arc<crypto::Keypair>,
    pub_key: String,
    peers: Arc<RwLock<Vec<String>>>,
    known_records: Arc<RwLock<HashMap<String, records::BaseRecord>>>,
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

    let state = Arc::new(AppState {
        store,
        keypair,
        pub_key,
        peers: Arc::new(RwLock::new(Vec::new())),
        known_records: Arc::new(RwLock::new(HashMap::new())),
    });

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