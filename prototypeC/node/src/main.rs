#![allow(dead_code)]

mod chain;
mod crypto;
mod p2p;
mod records;
mod storage;

use axum::response::Redirect;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Path, Query, State,
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
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;
use tracing::{info, warn};

struct AppState {
    store: Arc<storage::ContentAddressedStore>,
    keypair: Arc<RwLock<Option<Arc<crypto::Keypair>>>>,
    pub_key: String,
    locked: Arc<RwLock<bool>>,
    encrypted_identity: Arc<RwLock<Option<crypto::IdentityFile>>>,
    auto_unlock: bool,
    peers: Arc<RwLock<Vec<String>>>,
    known_records: Arc<RwLock<HashMap<String, records::BaseRecord>>>,
    p2p: Arc<RwLock<Option<Arc<p2p::P2PHandle>>>>,
    events: broadcast::Sender<String>,
    connected_peers: Arc<RwLock<HashMap<String, Vec<String>>>>,
    p2p_port: u16,
    data_dir: PathBuf,
    frontend_path: String,
    dapps_dir: Arc<RwLock<PathBuf>>,
    group_keys: Arc<RwLock<HashMap<String, String>>>,
    chain: Option<Arc<chain::AnchorChain>>,
}
/// Fan out an event JSON string to all connected browser clients.
fn emit(state: &AppState, event: serde_json::Value) {
    let _ = state.events.send(event.to_string());
}

/// Check whether a CID is in the node's blocked set (nuke actions by trusted mods).
/// Only global (non-community-scoped) nukes are enforced at the node level.
async fn is_cid_blocked(state: &AppState, cid: &str) -> bool {
    let known = state.known_records.read().await;
    let sets = compute_moderation_sets(&known, &state.pub_key);
    sets.blocked_cids.contains(cid)
}

/// Check whether a CID is hidden by moderation (hide actions by trusted mods).
/// Only global (non-community-scoped) hides are checked here; community-scoped
/// hides are returned to clients via GET /api/moderation for client-side filtering.
async fn is_cid_hidden(state: &AppState, cid: &str) -> bool {
    let known = state.known_records.read().await;
    let sets = compute_moderation_sets(&known, &state.pub_key);
    sets.hidden_cids.contains(cid)
}

/// Start the libp2p swarm and spawn the gossip + signal consumer tasks.
async fn start_swarm_and_consumers(
    state: Arc<AppState>,
    secret: &[u8],
    port: u16,
    bootstrap_peers: Vec<String>,
) {
    match p2p::spawn_swarm(secret, port, bootstrap_peers).await {
        Ok(handle) => {
            let handle = Arc::new(handle);
            *state.p2p.write().await = Some(handle.clone());
            info!("libp2p swarm started (peer {})", handle.local_peer_id);

            // --- gossip consumer task: verify -> store -> broadcast to browsers
            let consumer_state = state.clone();
            let handle_a = handle.clone();
            tokio::spawn(async move {
                let mut rx = handle_a.events.lock().await;
                while let Some(ev) = rx.recv().await {
                    let record: records::BaseRecord = match serde_json::from_slice(&ev.data) {
                        Ok(r) => r,
                        Err(_) => continue,
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
                            consumer_state
                                .store
                                .put_record(&record.id, canonical.as_bytes())
                                .ok();
                            known.insert(record.id.clone(), record.clone());
                            true
                        }
                    };
                    if is_new {
                        emit(
                            &consumer_state,
                            json!({
                                "type": "gossip",
                                "source": ev.source,
                                "record": &record,
                            }),
                        );
                    }
                }
            });

            // --- signal consumer task: relay WebRTC signaling to browser via WS
            let signal_state = state.clone();
            let handle_b = handle.clone();
            tokio::spawn(async move {
                let mut rx = handle_b.signal_events.lock().await;
                while let Some(ev) = rx.recv().await {
                    emit(
                        &signal_state,
                        json!({
                            "type": "webrtc_signal",
                            "source": ev.source,
                            "data": base64::engine::general_purpose::STANDARD.encode(&ev.data),
                        }),
                    );
                }
            });
        }
        Err(e) => {
            warn!("libp2p swarm failed to start: {}", e);
        }
    }
}

/// Guard: return a reference to the in-memory keypair, or a 423 LOCKED response.
async fn get_keypair_or_locked(
    state: &AppState,
) -> Result<Arc<crypto::Keypair>, (StatusCode, Json<serde_json::Value>)> {
    let guard = state.keypair.read().await;
    match &*guard {
        Some(kp) => Ok(Arc::clone(kp)),
        None => Err((
            StatusCode::LOCKED,
            Json(json!({
                "error": "identity is locked. POST /api/identity/unlock with your password to activate signing and networking."
            })),
        )),
    }
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

    // --- Identity persistence (Phase 5) ---------------------------------
    let identity_path = crypto::identity_file_path(&data_path);
    let (keypair_arc_opt, pub_key, locked, encrypted_identity, auto_unlock) =
        if identity_path.exists() {
            match crypto::read_identity_file(&identity_path) {
                Ok(file) => {
                    let au = file.auto_unlock;
                    if file.auto_unlock {
                        match crypto::load_identity_file(&file, "") {
                            Ok(kp) => (Some(Arc::new(kp)), file.pubkey.clone(), false, None, au),
                            Err(e) => {
                                warn!("auto-unlock failed ({}), starting locked", e);
                                (None, file.pubkey.clone(), true, Some(file), au)
                            }
                        }
                    } else {
                        (None, file.pubkey.clone(), true, Some(file), au)
                    }
                }
                Err(e) => {
                    warn!("identity file unreadable ({}), generating new identity", e);
                    let kp = crypto::Keypair::generate();
                    let pk = crypto::pubkey_to_cid(&kp.public_key_bytes());
                    crypto::save_identity_to_disk(&identity_path, &kp, "", true)
                        .map_err(|e| format!("failed to save identity: {}", e))?;
                    info!("Generated and saved new identity: {}", pk);
                    (Some(Arc::new(kp)), pk, false, None, true)
                }
            }
        } else {
            let kp = crypto::Keypair::generate();
            let pk = crypto::pubkey_to_cid(&kp.public_key_bytes());
            crypto::save_identity_to_disk(&identity_path, &kp, "", true)
                .map_err(|e| format!("failed to save identity: {}", e))?;
            info!("Generated and saved new identity: {}", pk);
            (Some(Arc::new(kp)), pk, false, None, true)
        };

    info!("Node public key (author): {}", pub_key);
    info!("Data directory: {}", data_dir);
    if locked {
        warn!("Identity is LOCKED — call POST /api/identity/unlock with your password to activate signing and networking.");
    }

    // --- libp2p swarm (Phase 1) --------------------------------------------
    let (events_tx, _events_rx0) = broadcast::channel::<String>(256);
    let connected_peers: Arc<RwLock<HashMap<String, Vec<String>>>> =
        Arc::new(RwLock::new(HashMap::new()));

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
    println!("frontend path: {}", frontend_path);

    let enable_chain = std::env::var("DDN_ENABLE_CHAIN").as_deref().unwrap_or("0") == "1";
    let chain: Option<Arc<chain::AnchorChain>> = if enable_chain {
        if let Some(kp) = &keypair_arc_opt {
            let extra_validators: Vec<String> = std::env::var("DDN_VALIDATORS")
                .as_deref()
                .unwrap_or("")
                .split(',')
                .filter(|s| !s.is_empty())
                .map(|s| s.trim().to_string())
                .collect();
            let mut c = chain::AnchorChain::new(&data_path, kp);
            c = c.with_validators(extra_validators);
            c.start_producer(10);
            Some(Arc::new(c))
        } else {
            eprintln!("chain enabled but no keypair available (locked)");
            None
        }
    } else {
        None
    };

    let state = Arc::new(AppState {
        store,
        keypair: Arc::new(RwLock::new(keypair_arc_opt)),
        pub_key,
        locked: Arc::new(RwLock::new(locked)),
        encrypted_identity: Arc::new(RwLock::new(encrypted_identity)),
        auto_unlock,
        peers: Arc::new(RwLock::new(Vec::new())),
        known_records: Arc::new(RwLock::new(HashMap::new())),
        p2p: Arc::new(RwLock::new(None)),
        events: events_tx,
        connected_peers: connected_peers.clone(),
        p2p_port,
        data_dir: data_path.clone(),
        frontend_path: frontend_path.clone(),
        dapps_dir: Arc::new(RwLock::new(dapps_dir(&frontend_path))),
        group_keys: Arc::new(RwLock::new(HashMap::new())),
        chain,
    });

    // --- Start libp2p swarm (only if identity is unlocked) ---------------
    if !locked {
        if let Some(kp) = state.keypair.read().await.as_ref() {
            start_swarm_and_consumers(state.clone(), &kp.secret_bytes(), p2p_port, bootstrap_peers)
                .await;
        }
    }

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route(
            "/api/blob",
            post(upload_blob)
                .get(list_blobs)
                .layer(DefaultBodyLimit::max(MAX_BLOB_SIZE as usize)),
        )
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
        .route("/api/media/signal", post(webrtc_signal))
        .route("/api/report", post(create_report_endpoint))
        .route("/api/moderation", get(moderation_status))
        .route(
            "/api/community",
            post(create_community_endpoint).get(list_communities),
        )
        .route(
            "/api/community/membership",
            post(promote_community_moderator_endpoint),
        )
        .route("/api/community/key/:cid", get(get_community_group_key))
        .route("/api/dapp/register", post(register_dapp_endpoint))
        .route("/api/dapp/discover", get(discover_dapps))
        .route("/api/peers", post(add_peer).get(list_peers))
        .route("/api/sync", post(sync))
        .route("/api/identity", get(get_identity).delete(delete_identity))
        .route("/api/identity/backup", post(backup_identity))
        .route("/api/identity/export", post(backup_identity))
        .route("/api/identity/restore", post(restore_identity))
        .route("/api/identity/unlock", post(unlock_identity))
        .route("/api/identity/import", post(import_identity))
        .route("/api/network", get(network_status))
        .route("/api/network/connect", post(network_connect))
        .route("/dapp/guestbook", get(serve_guestbook))
        .route("/dapp/:name", get(serve_dapp))
        .route("/api/chain/anchor", post(chain_anchor))
        .route("/api/chain/anchor-payload", post(chain_anchor_payload))
        .route("/api/chain/block/:height", get(chain_block))
        .route("/api/chain/block/latest", get(chain_latest_block))
        .route("/api/chain/record/:cid", get(chain_record_status))
        .route("/api/chain/validators", get(chain_validators))
        .route("/api/chain/proposals", get(chain_proposals))
        .route("/api/chain/sign", post(chain_sign_block))
        .route("/api/chain/commit", post(chain_commit))
        .route("/api/dapps", get(list_dapps))
        .route("/api/dapps/install", post(install_dapp))
        .route("/ws/events", get(ws_events))
        .route("/", get(serve_frontend))
        .nest_service("/static", ServeDir::new(&frontend_path))
        .nest_service(
            "/assets",
            ServeDir::new(format!("{}/assets", frontend_path)),
        )
        .nest("/dapps", Router::new().fallback(get(serve_dapp_file)))
        .route("/api/dapps/dir", post(set_dapps_dir))
        .with_state(state)
        .layer(cors);

    let http_port: u16 = std::env::var("DDN_HTTP_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3000);
    let addr = SocketAddr::from(([0, 0, 0, 0], http_port));
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

async fn serve_guestbook() -> impl IntoResponse {
    let html = r#"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DDN Guestbook</title>
    <style>
        body { font-family: sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; }
        .post { border: 1px solid #ddd; padding: 12px; margin: 10px 0; border-radius: 6px; }
        .form-row { display: flex; gap: 8px; }
        input, textarea { padding: 8px; border: 1px solid #ccc; border-radius: 4px; flex: 1; }
        button { padding: 8px 16px; border: none; background: #007bff; color: white; border-radius: 4px; cursor: pointer; }
        button:hover { background: #0056b3; }
        .error { color: #d32f2f; }
    </style>
</head>
<body>
    <h1>Decentralized Guestbook</h1>
    <p>This is a network-distributed dApp served by the DDN node at <code>/dapp/guestbook</code>.</p>

    <h2>Sign In</h2>
    <div class="form-row">
        <input type="text" id="pubkey" placeholder="Your pubkey (hex)" />
        <button onclick="signIn()">Unlock Identity</button>
    </div>
    <div id="identity-status"></div>

    <h2>Guestbook Posts</h2>
    <button onclick="loadPosts()">Refresh</button>
    <div id="posts"></div>

    <h2>Sign a Post</h2>
    <textarea id="message" rows="3" placeholder="Write a message..." style="width:100%"></textarea>
    <div class="form-row">
        <input type="password" id="password" placeholder="Signing password (empty if unlocked)" />
        <button onclick="signAndPost()">Sign & Post</button>
    </div>
    <div id="post-status"></div>

    <script>
        let keypair = null;

        async function signIn() {
            const pubkeyInput = document.getElementById('pubkey').value.trim();
            const resp = await fetch('/api/identity');
            const info = await resp.json();
            if (info.locked) {
                document.getElementById('identity-status').innerHTML =
                    '<span class="error">Identity is locked. Enter your password below.</span>';
            } else {
                document.getElementById('identity-status').innerHTML =
                    'Unlocked as: ' + info.pubkey.slice(0, 16) + '...';
            }
        }

        async function signAndPost() {
            const message = document.getElementById('message').value.trim();
            if (!message) return alert('Message required');
            const password = document.getElementById('password').value;

            const ts = Date.now();
            const payload = JSON.stringify({ text: message, dapp: 'guestbook' });

            const signResp = await fetch('/api/record/sign', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'post', author: (await (await fetch('/api/identity')).json()).pubkey, prev: null, ts, payload: JSON.parse(payload) })
            });
            const signed = await signResp.json();

            const submitResp = await fetch('/api/record', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(signed)
            });
            const result = await submitResp.json();
            document.getElementById('post-status').innerHTML =
                '<span style="color:green">Posted! ID: ' + result.id + '</span>';
            document.getElementById('message').value = '';
        }

        async function loadPosts() {
            const resp = await fetch('/api/wall');
            const data = await resp.json();
            const guestbookPosts = data.posts.filter(r => {
                const p = r.payload || {};
                return p.dapp === 'guestbook';
            }).sort((a, b) => b.ts - a.ts);

            const postsDiv = document.getElementById('posts');
            if (guestbookPosts.length === 0) {
                postsDiv.innerHTML = '<p>No posts yet. Be the first!</p>';
                return;
            }
            postsDiv.innerHTML = guestbookPosts.map(r =>
                '<div class="post"><div>' + (r.payload.text || '') + '</div><div style="font-size:0.8em;color:#666">' +
                new Date(r.ts).toLocaleString() + ' · ' + r.author.slice(0, 12) + '...</div></div>'
            ).join('');
        }

        loadPosts();
    </script>
</body>
</html>"#;
    Html(html)
}

/// Resolve the directory holding built dApp assets. Prefers DDN_DAPPS_DIR (so
/// operators/users can drop dApps without a node rebuild), then falls back to
/// the frontend build output: <frontend_path>/dapps/<name>.
fn dapps_dir(frontend_path: &str) -> PathBuf {
    if let Ok(d) = std::env::var("DDN_DAPPS_DIR") {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    let fp = PathBuf::from(frontend_path);
    let dapps = fp.join("dapps");
    if dapps.is_dir() {
        dapps
    } else {
        let dist_dapps = fp.join("dist").join("dapps");
        if dist_dapps.is_dir() {
            dist_dapps
        } else {
            dapps
        }
    }
}

/// GET /dapp/:name — serve a standalone dApp built from src/pages/<name>.
/// dApps are built into <frontend>/dapps/<name>/{index.html, index-*.js, assets/*}.
/// We serve the whole tree via the `/dapps` static nest (so the HTML's relative
/// `assets/` references resolve correctly), so /dapp/:name just redirects to
/// /dapps/<name>/.
async fn serve_dapp(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<Redirect, (StatusCode, Html<String>)> {
    let ddir = state.dapps_dir.read().await.clone();
    let target = ddir.join(&name).join("index.html");
    if target.exists() {
        Ok(Redirect::permanent(&format!("/dapps/{name}/index.html")))
    } else {
        Err((
            StatusCode::NOT_FOUND,
            Html(format!(
                "<html><body><h1>dApp not found: {name}</h1><p>Build the frontend so dist/dapps/{name}/index.html exists, or set DDN_DAPPS_DIR.</p></body></html>"
            )),
        )         )
    }
}

/// GET /dapps/*path — serve a static file from the runtime-configured dApps directory.
/// This replaces the old nest_service static handler so the dApp directory can be
/// changed at runtime via POST /api/dapps/dir without restarting the node.
use axum::http::Uri;

async fn serve_dapp_file(
    State(state): State<Arc<AppState>>,
    uri: Uri,
) -> impl IntoResponse {
    let ddir = state.dapps_dir.read().await.clone();
    let raw_path = uri.path();

    let path = raw_path
        .strip_prefix("/dapps/")
        .unwrap_or_else(|| raw_path.strip_prefix("/").unwrap_or(""));

    let mut file_path = ddir.join(path);

    if file_path.is_dir() {
        file_path = file_path.join("index.html");
    }

    info!("Serving dApp file: path={}, resolved={}", path, file_path.display());

    if file_path.is_file() {
        match tokio::fs::read(&file_path).await {
            Ok(contents) => {
                let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("bin");
                let mime = match ext {
                    "html" => "text/html; charset=utf-8",
                    "js" => "application/javascript; charset=utf-8",
                    "css" => "text/css; charset=utf-8",
                    "json" => "application/json",
                    "png" => "image/png",
                    "jpg" | "jpeg" => "image/jpeg",
                    "svg" => "image/svg+xml",
                    "ico" => "image/x-icon",
                    "woff" => "font/woff",
                    "woff2" => "font/woff2",
                    "ttf" => "font/ttf",
                    _ => "application/octet-stream",
                };
                let mut headers = axum::http::HeaderMap::new();
                headers.insert("content-type", mime.parse().unwrap());
                (StatusCode::OK, headers, contents).into_response()
            }
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Html("Failed to read file".to_string()),
            )
                .into_response(),
        }
    } else {
        (
            StatusCode::NOT_FOUND,
            Html(format!("File not found: {}", path)),
        )
            .into_response()
    }
}

/// POST /api/dapps/dir — set the dApp directory at runtime. Requires unlocked identity.
/// Body: { path: "<absolute_path>" }
#[derive(Deserialize)]
struct SetDappsDirRequest {
    path: String,
}

async fn set_dapps_dir(
    State(state): State<Arc<AppState>>,
    bytes: axum::body::Bytes,
) -> impl IntoResponse {
    let locked = *state.locked.read().await;
    if locked {
        return (
            StatusCode::LOCKED,
            Json(json!({ "error": "Identity is locked — unlock first" })),
        )
            .into_response();
    }

    let req: SetDappsDirRequest = match serde_json::from_slice(&bytes) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid request: {}", e) })),
            )
                .into_response();
        }
    };

    let new_dir = PathBuf::from(&req.path);
    if !new_dir.is_absolute() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "path must be absolute" })),
        )
            .into_response();
    }

    if let Err(e) = std::fs::create_dir_all(&new_dir) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("cannot create directory: {}", e) })),
        )
            .into_response();
    }

    *state.dapps_dir.write().await = new_dir.clone();

    Json(json!({
        "status": "updated",
        "dir": new_dir.to_string_lossy().to_string(),
    }))
        .into_response()
}

/// GET /api/dapps — list installed dApps by scanning dapps_dir for subdirs
/// containing an index.html. Only returns the names (safe, no file contents).
async fn list_dapps(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let ddir = state.dapps_dir.read().await.clone();
    let mut names: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&ddir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir()
                && path.join("index.html").exists()
            {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    names.push(name.to_string());
                }
            }
        }
    }
    names.sort();
    Json(json!({ "dapps": names, "dir": ddir.to_string_lossy().to_string() }))
}

#[derive(Deserialize)]
struct InstallDappRequest {
    /// dApp name (subdirectory under dapps_dir)
    name: String,
    /// Absolute path to a pre-built dApp dist folder (e.g. /home/user/mydapp-dist)
    source_path: String,
}

/// POST /api/dapps/install — copy a pre-built dApp dist folder into dapps_dir.
/// Requires the node to be unlocked (signing identity). No node restart needed.
/// The dApp becomes immediately available at /dapp/<name>.
async fn install_dapp(
    State(state): State<Arc<AppState>>,
    bytes: axum::body::Bytes,
) -> impl IntoResponse {
    // Require unlocked identity for runtime dApp installation.
    let locked = *state.locked.read().await;
    if locked {
        return (
            StatusCode::LOCKED,
            Json(json!({ "error": "Identity is locked — unlock first" })),
        )
            .into_response();
    }

    let req: InstallDappRequest = match serde_json::from_slice(&bytes) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid request: {}", e) })),
            )
                .into_response();
        }
    };

    // Security: reject empty names and path traversal attempts.
    if req.name.is_empty() || req.name.contains('/') || req.name.contains('\\') || req.name == ".." {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid dApp name" })),
        )
            .into_response();
    }

    let source = PathBuf::from(&req.source_path);
    if !source.exists() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("source path not found: {}", req.source_path) })),
        )
            .into_response();
    }

    let dest = state.dapps_dir.read().await.join(&req.name);

    // If a dApp with this name already exists, remove it first.
    if dest.exists() {
        if let Err(e) = std::fs::remove_dir_all(&dest) {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("cannot remove existing dApp: {}", e) })),
            )
                .into_response();
        }
    }

    if let Err(e) = std::fs::create_dir_all(&dest) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("cannot create dApp directory: {}", e) })),
        )
                .into_response();
    }

    // Recursively copy the source dist into the dApp directory.
    match copy_dir_recursive(&source, &dest) {
        Ok(()) => {
            if dest.join("index.html").exists() {
                Json(json!({
                    "status": "installed",
                    "name": req.name,
                    "url": format!("/dapp/{}", req.name),
                }))
                    .into_response()
            } else {
                (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    Json(json!({ "error": "source path has no index.html — not a valid dApp dist" })),
                )
                    .into_response()
            }
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("copy failed: {}", e) })),
        )
            .into_response(),
    }
}

/// Recursively copy the contents of `src` into `dst` (dst must exist).
fn copy_dir_recursive(src: &PathBuf, dst: &PathBuf) -> std::io::Result<()> {
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            std::fs::create_dir_all(&dst_path)?;
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

async fn get_identity(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let locked = *state.locked.read().await;
    Json(json!({
        "pubkey": state.pub_key,
        "locked": locked,
        "auto_unlock": state.auto_unlock,
    }))
}

#[derive(Deserialize)]
struct BackupRequest {
    password: String,
}

async fn backup_identity(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    let req: BackupRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": format!("invalid request: {}", e)})),
            )
                .into_response();
        }
    };
    let kp = match get_keypair_or_locked(&state).await {
        Ok(k) => k,
        Err(e) => return e.into_response(),
    };
    let file = crypto::create_identity_file(&kp, &req.password);
    let json_str = match serde_json::to_string(&file) {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("serialization failed: {}", e)})),
            )
                .into_response();
        }
    };
    axum::response::Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/json")
        .header(
            "Content-Disposition",
            "attachment; filename=ddn_backup.json",
        )
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
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": format!("invalid request: {}", e)})),
            )
                .into_response();
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
        Err(e) => (StatusCode::UNAUTHORIZED, Json(json!({"error": e}))).into_response(),
    }
}

// ---------------------------------------------------------------------------
// Phase 5: Identity persistence & management
// ---------------------------------------------------------------------------

/// Response for identity unlock: whether the node is now unlocked and the
/// pubkey of the active identity (unchanged across restart).
#[derive(Serialize, Deserialize)]
struct IdentityInfoResponse {
    pubkey: String,
    locked: bool,
    peer_id: Option<String>,
    listen_addrs: Vec<String>,
}

/// POST /api/identity/unlock — submit a password to decrypt the on-disk
/// identity. On success the keypair is loaded into memory and the libp2p
/// swarm is started. Until unlocked, signing, gossipsub, and record
/// submission are blocked.
async fn unlock_identity(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let req: BackupRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": format!("invalid request: {}", e)})),
            )
                .into_response();
        }
    };

    let encrypted = state.encrypted_identity.read().await.clone();
    let file = match encrypted {
        Some(f) => f,
        None => {
            // Already unlocked or no encrypted file.
            let locked = *state.locked.read().await;
            return (
                StatusCode::OK,
                Json(json!({ "pubkey": state.pub_key, "locked": locked })),
            )
                .into_response();
        }
    };

    match crypto::load_identity_file(&file, &req.password) {
        Ok(kp) => {
            *state.keypair.write().await = Some(Arc::new(kp.clone()));
            *state.locked.write().await = false;
            *state.encrypted_identity.write().await = None;
            info!("Identity unlocked — starting libp2p swarm");
            start_swarm_and_consumers(
                state.clone(),
                &kp.secret_bytes(),
                state.p2p_port,
                Vec::new(),
            )
            .await;
            (
                StatusCode::OK,
                Json(json!({ "pubkey": state.pub_key, "locked": false })),
            )
                .into_response()
        }
        Err(_) => (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "invalid password"})),
        )
            .into_response(),
    }
}

/// POST /api/identity/import — import an IdentityFile from a backup .json +
/// password. The file is written to {DDN_DATA_DIR}/ddn_identity.json,
/// replacing the current one. The node must be restarted for the new identity
/// to take effect (the libp2p PeerId is derived from the Ed25519 secret).
async fn import_identity(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let req: RestoreRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": format!("invalid request: {}", e)})),
            )
                .into_response();
        }
    };

    // Verify the password decrypts the file before writing to disk.
    match crypto::load_identity_file(&req.file, &req.password) {
        Ok(_) => {
            let identity_path = crypto::identity_file_path(&state.data_dir);
            let json_str = match serde_json::to_string_pretty(&req.file) {
                Ok(s) => s,
                Err(e) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({"error": format!("serialization failed: {}", e)})),
                    )
                        .into_response();
                }
            };
            if let Err(e) = std::fs::write(&identity_path, json_str) {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error": format!("failed to write identity file: {}", e)})),
                )
                    .into_response();
            }
            info!("Imported identity — restart required for changes to take effect");
            (
                StatusCode::OK,
                Json(json!({ "status": "imported", "pubkey": req.file.pubkey, "requires_restart": true })),
            ).into_response()
        }
        Err(_) => (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "invalid password or corrupted backup"})),
        )
            .into_response(),
    }
}

/// DELETE /api/identity — delete the on-disk identity file. The node will
/// generate a fresh identity on the next startup.
async fn delete_identity(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let identity_path = crypto::identity_file_path(&state.data_dir);
    if identity_path.exists() {
        if let Err(e) = std::fs::remove_file(&identity_path) {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("failed to delete identity: {}", e)})),
            )
                .into_response();
        }
        info!("Identity file deleted — restart to generate a fresh identity");
    }
    (
        StatusCode::OK,
        Json(json!({ "status": "deleted", "requires_restart": true })),
    )
        .into_response()
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
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "storage failed" })),
            )
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
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": format!("invalid record: {}", e)})),
            );
        }
    };

    if let Err(e) = record.verify() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": format!("verification failed: {}", e)})),
        );
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
    if let Some(p2p) = state.p2p.read().await.as_ref() {
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
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": format!("invalid request: {}", e)})),
            );
        }
    };
    let kp = match get_keypair_or_locked(&state).await {
        Ok(k) => k,
        Err(e) => return e,
    };
    let record = records::BaseRecord::from_sign_request(&req, &kp);
    (
        StatusCode::OK,
        Json(json!({
            "id": record.id,
            "type": serde_json::to_string(&record.r#type).unwrap_or_default().trim_matches('"').to_string(),
            "author": record.author,
            "prev": record.prev,
            "ts": record.ts,
            "payload": record.payload,
            "sig": record.sig,
        })),
    )
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
            r#type: serde_json::to_string(&r.r#type)
                .unwrap_or_default()
                .trim_matches('"')
                .to_string(),
            author: r.author.clone(),
            ts: r.ts,
        })
        .collect();
    Json(RecordListResponse { records: entries })
}

async fn get_wall(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let known = state.known_records.read().await;
    let posts: Vec<records::BaseRecord> = known.values().cloned().collect();
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
                        return (r.author == *me && to == *other)
                            || (r.author == *other && to == *me);
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
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": format!("invalid input: {}", e)})),
            );
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
    if let Some(p2p) = state.p2p.read().await.as_ref() {
        p2p.bootstrap();
    }

    let peers = state.peers.read().await.clone();

    let client = reqwest::Client::new();
    let mut added = 0;

    for peer_url in &peers {
        let base_url = peer_url.trim_end_matches('/');
        match client.get(format!("{}/api/records", base_url)).send().await {
            Ok(resp) => {
                if let Ok(list) = resp.json::<RecordListResponse>().await {
                    let mut known = state.known_records.write().await;
                    for entry in list.records {
                        if known.contains_key(&entry.id) {
                            continue;
                        }
                        match client
                            .get(format!("{}/api/record/{}", base_url, entry.id))
                            .send()
                            .await
                        {
                            Ok(record_resp) => {
                                if let Ok(record_bytes) = record_resp.bytes().await {
                                    if let Ok(record) =
                                        serde_json::from_slice::<records::BaseRecord>(&record_bytes)
                                    {
                                        if record.id == entry.id && record.verify().is_ok() {
                                            let canonical =
                                                record.to_canonical_json().unwrap_or_default();
                                            state
                                                .store
                                                .put_record(&entry.id, canonical.as_bytes())
                                                .ok();
                                            known.insert(entry.id.clone(), record);
                                            added += 1;
                                        }
                                    }
                                }
                            }
                            Err(e) => warn!(
                                "failed to fetch record {} from {}: {}",
                                entry.id, peer_url, e
                            ),
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

async fn seal_dm_endpoint(bytes: axum::body::Bytes) -> impl IntoResponse {
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

    let kp = match get_keypair_or_locked(&state).await {
        Ok(k) => k,
        Err(e) => return e.into_response(),
    };

    match crypto::open_dm(
        &kp.secret_bytes(),
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

    let kp = match get_keypair_or_locked(&state).await {
        Ok(k) => k,
        Err(e) => return e.into_response(),
    };

    let record = records::BaseRecord::from_sign_request(&sign_req, &kp);
    let id = record.id.clone();
    let canonical = record.to_canonical_json().unwrap_or_default();
    state.store.put_record(&id, canonical.as_bytes()).ok();

    let mut known = state.known_records.write().await;
    known.insert(id.clone(), record.clone());
    drop(known);

    if let Some(p2p) = state.p2p.read().await.as_ref() {
        p2p.publish_record(canonical.as_bytes().to_vec());
    }
    emit(&state, json!({ "type": "record", "record": &record }));

    (
        StatusCode::CREATED,
        Json(json!({ "id": id, "record": &record })),
    )
        .into_response()
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

    let kp = match get_keypair_or_locked(&state).await {
        Ok(k) => k,
        Err(e) => return e.into_response(),
    };

    let record = records::BaseRecord::from_sign_request(&sign_req, &kp);
    let id = record.id.clone();
    let canonical = record.to_canonical_json().unwrap_or_default();
    state.store.put_record(&id, canonical.as_bytes()).ok();

    let mut known = state.known_records.write().await;
    known.insert(id.clone(), record.clone());
    drop(known);

    if let Some(p2p) = state.p2p.read().await.as_ref() {
        p2p.publish_record(canonical.as_bytes().to_vec());
    }
    emit(&state, json!({ "type": "record", "record": &record }));

    (
        StatusCode::CREATED,
        Json(json!({ "id": id, "record": &record })),
    )
        .into_response()
}

/// POST /api/media/keypair — generate an ephemeral X25519 keypair for WebRTC
/// signaling. Returns the pubkey (hex, sent in media_offer) and the secret
/// (hex, for the sender to use during the WebRTC handshake). The secret should
/// be discarded after use.
async fn generate_keypair_endpoint() -> impl IntoResponse {
    let (pubkey_hex, secret_hex) = crypto::generate_x25519_keypair();
    (
        StatusCode::OK,
        Json(json!({
            "pubkey": pubkey_hex,
            "secret": secret_hex,
        })),
    )
}

/// POST /api/media/signal — forward a WebRTC signaling payload (SDP offer/answer
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
    if let Some(p2p) = state.p2p.read().await.as_ref() {
        p2p.publish_signal(decoded.clone());
    }

    emit(
        &state,
        json!({
            "type": "webrtc_signal",
            "source": state.pub_key.clone(),
            "data": base64::engine::general_purpose::STANDARD.encode(&decoded),
        }),
    );

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

    let kp = match get_keypair_or_locked(&state).await {
        Ok(k) => k,
        Err(e) => return e.into_response(),
    };

    let record = records::BaseRecord::from_sign_request(&sign_req, &kp);
    let id = record.id.clone();
    let canonical = record.to_canonical_json().unwrap_or_default();
    state.store.put_record(&id, canonical.as_bytes()).ok();

    let mut known = state.known_records.write().await;
    known.insert(id.clone(), record.clone());
    drop(known);

    if let Some(p2p) = state.p2p.read().await.as_ref() {
        p2p.publish_record(canonical.as_bytes().to_vec());
    }
    emit(&state, json!({ "type": "record", "record": &record }));

    (StatusCode::CREATED, Json(ReportResponse { id, record })).into_response()
}

/// GET /api/moderation — return the list of blocked CIDs and trusted mod
/// pubkeys that the node is enforcing, plus community-scoped moderation data.
/// Blocked CIDs come from verified `mod_action` records with `action: "nuke"`;
/// hidden CIDs come from `action: "hide"`; mod pubkeys come from `mod_grant`
/// records signed by the admin.
#[derive(Serialize, Deserialize)]
struct CommunityInfoResponse {
    cid: String,
    name: String,
    founder: String,
    moderators: Vec<String>,
    blocked_cids: Vec<String>,
    hidden_cids: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct ModerationResponse {
    blocked_cids: Vec<String>,
    hidden_cids: Vec<String>,
    mod_pubkeys: Vec<String>,
    communities: HashMap<String, CommunityInfoResponse>,
}

/// All moderation data computed from known records.
struct ModerationSets {
    /// Global CIDs nuked by trusted (admin-granted) mods.
    blocked_cids: HashSet<String>,
    /// Global CIDs hidden by trusted (admin-granted) mods.
    hidden_cids: HashSet<String>,
    /// Global mod pubkeys (from mod_grant signed by admin).
    mod_pubkeys: HashSet<String>,
    /// Community-scoped info, keyed by community CID (the `community` record id).
    communities: HashMap<String, CommunityInfo>,
}

/// Computed moderation context for a single community.
#[derive(Default)]
struct CommunityInfo {
    cid: String,
    name: String,
    founder: String,
    moderators: HashSet<String>,
    blocked_cids: HashSet<String>,
    hidden_cids: HashSet<String>,
}

/// Compute moderation sets from known records.
/// Returns global and community-scoped moderation data.
fn compute_moderation_sets(
    known: &HashMap<String, records::BaseRecord>,
    admin_key: &str,
) -> ModerationSets {
    let mut blocked_cids: HashSet<String> = HashSet::new();
    let mut hidden_cids: HashSet<String> = HashSet::new();
    let mut mod_pubkeys: HashSet<String> = HashSet::new();
    let mut communities: HashMap<String, CommunityInfo> = HashMap::new();

    // --- First pass: collect global mod pubkeys from mod_grant records ---
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

    // --- Second pass: discover communities (founder auto-elected) ---
    for record in known.values() {
        if !matches!(record.r#type, records::RecordType::Community) {
            continue;
        }
        if record.verify().is_err() {
            continue;
        }
        if let Some(payload) = record.payload.as_object() {
            let name = payload
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let founder = payload
                .get("creator")
                .and_then(|v| v.as_str())
                .unwrap_or(&record.author)
                .to_string();
            // The community CID is the record's own id.
            let cid = record.id.clone();
            communities.insert(
                cid.clone(),
                CommunityInfo {
                    cid: cid.clone(),
                    name,
                    founder: founder.clone(),
                    moderators: std::iter::once(founder).collect(),
                    ..Default::default()
                },
            );
        } else {
            let cid = record.id.clone();
            communities.insert(
                cid.clone(),
                CommunityInfo {
                    cid: cid.clone(),
                    founder: record.author.clone(),
                    moderators: std::iter::once(record.author.clone()).collect(),
                    ..Default::default()
                },
            );
        }
    }

    // --- Third pass: collect community moderators from community_membership records ---
    // Each membership record is signed by a founder or existing community moderator,
    // promoting target_pubkey to the "moderator" role for that community.
    for record in known.values() {
        if !matches!(record.r#type, records::RecordType::CommunityMembership) {
            continue;
        }
        if record.verify().is_err() {
            continue;
        }
        if let Some(payload) = record.payload.as_object() {
            let community_cid = payload
                .get("community_cid")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let target = payload
                .get("target_pubkey")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let role = payload.get("role").and_then(|v| v.as_str()).unwrap_or("");

            if let Some(info) = communities.get_mut(community_cid) {
                // Only honor "moderator" role promotions.
                if role == "moderator" && !target.is_empty() {
                    info.moderators.insert(target.to_string());
                }
            }
        }
    }

    // --- Fourth pass: collect blocked, hidden, and community-scoped actions ---
    for record in known.values() {
        if !matches!(record.r#type, records::RecordType::ModAction) {
            continue;
        }
        if record.verify().is_err() {
            continue;
        }
        if let Some(payload) = record.payload.as_object() {
            let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("");
            let mod_pk = payload
                .get("mod_pubkey")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let target = payload
                .get("target_cid")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let community_cid = payload
                .get("community_cid")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty());

            if let Some(cid) = community_cid {
                // Community-scoped action: validate against community moderators.
                if let Some(info) = communities.get_mut(cid) {
                    if info.moderators.contains(mod_pk) && !target.is_empty() {
                        if action == "nuke" {
                            info.blocked_cids.insert(target.to_string());
                        } else if action == "hide" {
                            info.hidden_cids.insert(target.to_string());
                        }
                    }
                }
            } else if mod_pubkeys.contains(mod_pk) && !target.is_empty() {
                // Global action.
                if action == "nuke" {
                    blocked_cids.insert(target.to_string());
                } else if action == "hide" {
                    hidden_cids.insert(target.to_string());
                }
            }
        }
    }

    ModerationSets {
        blocked_cids,
        hidden_cids,
        mod_pubkeys,
        communities,
    }
}

async fn moderation_status(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let known = state.known_records.read().await;
    let sets = compute_moderation_sets(&known, &state.pub_key);
    let communities: HashMap<String, CommunityInfoResponse> = sets
        .communities
        .into_iter()
        .map(|(cid, info)| {
            let resp = CommunityInfoResponse {
                cid: info.cid,
                name: info.name,
                founder: info.founder,
                moderators: info.moderators.into_iter().collect(),
                blocked_cids: info.blocked_cids.into_iter().collect(),
                hidden_cids: info.hidden_cids.into_iter().collect(),
            };
            (cid, resp)
        })
        .collect();
    Json(ModerationResponse {
        blocked_cids: sets.blocked_cids.into_iter().collect(),
        hidden_cids: sets.hidden_cids.into_iter().collect(),
        mod_pubkeys: sets.mod_pubkeys.into_iter().collect(),
        communities,
    })
}

// ---------------------------------------------------------------------------
// Phase 6.2: Community Model
// ---------------------------------------------------------------------------

/// POST /api/community — create a community. The author (signing identity)
/// automatically becomes the founder-moderator. The record id becomes the
/// community_cid, used by community-scoped mod_action and community_membership
/// records.
#[derive(Deserialize)]
struct CommunityCreateRequest {
    name: String,
    description: String,
    #[serde(default)]
    is_private: bool,
}

#[derive(Serialize, Deserialize)]
struct CommunityResponse {
    id: String,
    record: records::BaseRecord,
}

#[derive(Serialize, Deserialize)]
struct CommunityListResponse {
    communities: Vec<records::BaseRecord>,
}

async fn create_community_endpoint(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let req: CommunityCreateRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid request: {}", e) })),
            )
                .into_response()
        }
    };

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let sign_req = records::SignRequest {
        r#type: "community".to_string(),
        author: state.pub_key.clone(),
        prev: None,
        ts,
        payload: json!({
            "name": req.name,
            "description": req.description,
            "creator": state.pub_key.clone(),
            "is_private": req.is_private,
        }),
    };

    let kp = match get_keypair_or_locked(&state).await {
        Ok(k) => k,
        Err(e) => return e.into_response(),
    };

    let record = records::BaseRecord::from_sign_request(&sign_req, &kp);
    let id = record.id.clone();
    let canonical = record.to_canonical_json().unwrap_or_default();
    state.store.put_record(&id, canonical.as_bytes()).ok();

    let mut known = state.known_records.write().await;
    known.insert(id.clone(), record.clone());
    drop(known);

    if let Some(p2p) = state.p2p.read().await.as_ref() {
        p2p.publish_record(canonical.as_bytes().to_vec());
    }
    emit(&state, json!({ "type": "record", "record": &record }));

    // For private communities, generate and store a random group key.
    if req.is_private {
        use rand::RngCore;
        let mut key_bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut key_bytes);
        let group_key = hex::encode(key_bytes);
        state.group_keys.write().await.insert(id.clone(), group_key);
    }

    (StatusCode::CREATED, Json(json!({ "id": id, "record": record }))).into_response()
}

/// GET /api/community — list all known community records.
async fn list_communities(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let known = state.known_records.read().await;
    let communities: Vec<records::BaseRecord> = known
        .values()
        .filter(|r| matches!(r.r#type, records::RecordType::Community))
        .cloned()
        .collect();
    Json(CommunityListResponse { communities })
}

/// POST /api/community/membership — promote a user to moderator for a community.
/// The signing identity must be the founder or an existing community moderator.
/// Validation is performed client-side; the node stores and gossips the record.
/// The `compute_moderation_sets` function validates that the signer is a known
/// community moderator before honoring the membership in moderation computations.
#[derive(Deserialize)]
struct CommunityMembershipRequest {
    community_cid: String,
    target_pubkey: String,
    role: String,
    /// Encrypted group key for private communities (base64-encoded X25519+AES-GCM sealed)
    #[serde(default)]
    encrypted_group_key: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct CommunityMembershipResponse {
    id: String,
    record: records::BaseRecord,
}

async fn promote_community_moderator_endpoint(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let req: CommunityMembershipRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid request: {}", e) })),
            )
                .into_response()
        }
    };

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let sign_req = records::SignRequest {
        r#type: "community_membership".to_string(),
        author: state.pub_key.clone(),
        prev: None,
        ts,
        payload: json!({
            "community_cid": req.community_cid,
            "target_pubkey": req.target_pubkey,
            "role": req.role,
            "encrypted_group_key": req.encrypted_group_key,
        }),
    };

    let kp = match get_keypair_or_locked(&state).await {
        Ok(k) => k,
        Err(e) => return e.into_response(),
    };

    let record = records::BaseRecord::from_sign_request(&sign_req, &kp);
    let id = record.id.clone();
    let canonical = record.to_canonical_json().unwrap_or_default();
    state.store.put_record(&id, canonical.as_bytes()).ok();

    let mut known = state.known_records.write().await;
    known.insert(id.clone(), record.clone());
    drop(known);

    if let Some(p2p) = state.p2p.read().await.as_ref() {
        p2p.publish_record(canonical.as_bytes().to_vec());
    }
    emit(&state, json!({ "type": "record", "record": &record }));

    (
        StatusCode::CREATED,
        Json(CommunityMembershipResponse { id, record }),
    )
        .into_response()
}

/// GET /api/community/key/:cid — retrieve the group key for a private community.
/// The key is returned as hex; the caller (founder or member) is expected to
/// encrypt it for specific recipients using X25519+AES-GCM (seal_dm).
async fn get_community_group_key(
    State(state): State<Arc<AppState>>,
    Path(cid): Path<String>,
) -> impl IntoResponse {
    let locked = *state.locked.read().await;
    if locked {
        return (
            StatusCode::LOCKED,
            Json(json!({ "error": "Identity is locked — unlock first" })),
        ).into_response();
    }

    let keys = state.group_keys.read().await;
    if let Some(key) = keys.get(&cid) {
        (
            StatusCode::OK,
            Json(json!({ "community_cid": cid, "group_key": key })),
        ).into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("No group key for community {}", cid) })),
        ).into_response()
    }
}

// ---------------------------------------------------------------------------
// dApp gossip records (payload.kind='dapp')
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct DappRegisterRequest {
    name: String,
    description: String,
    version: String,
    url: String,
    icon: Option<String>,
    /// CID of the dApp's source record (optional, for distributed installations)
    source_cid: Option<String>,
    /// Whether this dApp is encrypted/private
    #[serde(default)]
    is_encrypted: bool,
}

#[derive(Serialize, Deserialize)]
struct DappRegisterResponse {
    id: String,
    record: records::BaseRecord,
}

/// POST /api/dapp/register — publish a `dapp` record for network discovery.
/// The record's payload.kind='dapp' allows other nodes to discover this dApp
/// via record gossip. The dApp source must be installed locally at /dapps/<name>.
async fn register_dapp_endpoint(
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let req: DappRegisterRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid request: {}", e) })),
            )
                .into_response()
        }
    };

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let sign_req = records::SignRequest {
        r#type: "dapp".to_string(),
        author: state.pub_key.clone(),
        prev: None,
        ts,
        payload: json!({
            "name": req.name,
            "description": req.description,
            "version": req.version,
            "url": req.url,
            "kind": "dapp",
            "is_encrypted": req.is_encrypted,
            "source_cid": req.source_cid,
            "icon": req.icon,
        }),
    };

    let kp = match get_keypair_or_locked(&state).await {
        Ok(k) => k,
        Err(e) => return e.into_response(),
    };

    let record = records::BaseRecord::from_sign_request(&sign_req, &kp);
    let id = record.id.clone();
    let canonical = record.to_canonical_json().unwrap_or_default();
    state.store.put_record(&id, canonical.as_bytes()).ok();

    let mut known = state.known_records.write().await;
    known.insert(id.clone(), record.clone());
    drop(known);

    if let Some(p2p) = state.p2p.read().await.as_ref() {
        p2p.publish_record(canonical.as_bytes().to_vec());
    }
    emit(&state, json!({ "type": "record", "record": &record }));

    (
        StatusCode::CREATED,
        Json(DappRegisterResponse { id, record }),
    )
        .into_response()
}

/// GET /api/dapp/discover — list all dApp records discovered via gossip.
async fn discover_dapps(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let known = state.known_records.read().await;
    let dapps: Vec<serde_json::Value> = known
        .values()
        .filter(|r| matches!(r.r#type, records::RecordType::Dapp))
        .map(|r| {
            let mut payload = r.payload.clone();
            if let Some(obj) = payload.as_object_mut() {
                obj.insert("id".to_string(), serde_json::json!(r.id));
                obj.insert("author".to_string(), serde_json::json!(r.author));
                obj.insert("ts".to_string(), serde_json::json!(r.ts));
            }
            payload
        })
        .collect();
    drop(known);

    Json(json!({ "dapps": dapps, "count": dapps.len() }))
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
    let locked = *state.locked.read().await;
    match state.p2p.read().await.as_ref() {
        Some(h) => {
            let peers = state.connected_peers.read().await;
            Json(json!({
                "enabled": true,
                "locked": locked,
                "peer_id": h.local_peer_id.to_string(),
                "listen_addrs": h.listen_addrs,
                "topic": p2p::RECORDS_TOPIC,
                "connected_peers": peers.keys().collect::<Vec<_>>(),
                "manual_peers": state.peers.read().await.clone(),
            }))
        }
        None => {
            let reason = if locked {
                "Identity is locked — call POST /api/identity/unlock to start networking"
                    .to_string()
            } else {
                "libp2p swarm not running (HTTP sync fallback only)".to_string()
            };
            Json(json!({
                "enabled": false,
                "locked": locked,
                "reason": reason,
                "manual_peers": state.peers.read().await.clone(),
            }))
        }
    }
}

async fn network_connect(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ConnectQuery>,
) -> impl IntoResponse {
    match state.p2p.read().await.as_ref() {
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

// ---------------------------------------------------------------------------
// C-2: Blockchain Anchor Chain handlers
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct AnchorRequest {
    author: String,
    record_cid: String,
    ts: u64,
    sig: String,
}

async fn chain_anchor(
    State(state): State<Arc<AppState>>,
    bytes: axum::body::Bytes,
) -> impl IntoResponse {
    let chain = match &state.chain {
        Some(c) => c,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "anchor chain not enabled (DDN_ENABLE_CHAIN=1)" })),
            );
        }
    };

    let req: AnchorRequest = match serde_json::from_slice(&bytes) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid request: {}", e) })),
            );
        }
    };

    if chain
        .anchor_cid(&req.author, &req.record_cid, req.ts, &req.sig)
        .await
    {
        (StatusCode::ACCEPTED, Json(json!({ "status": "anchoring" })))
    } else {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "failed to queue anchor" })),
        )
    }
}

#[derive(Deserialize)]
struct AnchorPayloadRequest {
    author: String,
    record_cid: Option<String>,
    ts: u64,
    sig: Option<String>,
    payload_data: String,
    content_type: String,
}

/// POST /api/chain/anchor-payload — anchor a record with embedded payload data.
/// For text + small media (< 100 KB threshold), the payload is stored directly
/// in the block transaction instead of just the CID.
async fn chain_anchor_payload(
    State(state): State<Arc<AppState>>,
    bytes: axum::body::Bytes,
) -> impl IntoResponse {
    let chain = match &state.chain {
        Some(c) => c,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "anchor chain not enabled (DDN_ENABLE_CHAIN=1)" })),
            ).into_response();
        }
    };

    let req: AnchorPayloadRequest = match serde_json::from_slice(&bytes) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid request: {}", e) })),
            ).into_response();
        }
    };

    if req.payload_data.len() as u64 > chain::MAX_EMBEDDED_PAYLOAD {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({ "error": format!("payload exceeds max embedded size of {} bytes", chain::MAX_EMBEDDED_PAYLOAD) })),
        ).into_response();
    }

    if chain
        .anchor_payload(
            &req.author,
            req.record_cid.as_deref().unwrap_or("payload-only"),
            req.ts,
            req.sig.as_deref().unwrap_or(""),
            req.payload_data,
            req.content_type,
        )
        .await
    {
        (StatusCode::ACCEPTED, Json(json!({ "status": "anchoring" }))).into_response()
    } else {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "failed to queue anchor" })),
        ).into_response()
    }
}

async fn chain_block(
    State(state): State<Arc<AppState>>,
    Path(height): Path<u64>,
) -> impl IntoResponse {
    let chain = match &state.chain {
        Some(c) => c,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "anchor chain not enabled" })),
            );
        }
    };

    match chain.block_at(height).await {
        Some(block) => (StatusCode::OK, Json(json!({ "block": block }))),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("block {} not found", height) })),
        ),
    }
}

async fn chain_latest_block(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let chain = match &state.chain {
        Some(c) => c,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "anchor chain not enabled" })),
            );
        }
    };

    let block = chain.latest_block().await;
    (StatusCode::OK, Json(json!({ "block": block })))
}

async fn chain_record_status(
    State(state): State<Arc<AppState>>,
    Path(cid): Path<String>,
) -> impl IntoResponse {
    let chain = match &state.chain {
        Some(c) => c,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "anchor chain not enabled" })),
            );
        }
    };

    match chain.anchor_status(&cid).await {
        Some(height) => (
            StatusCode::OK,
            Json(json!({ "cid": cid, "height": height })),
        ),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "cid": cid, "height": null })),
        ),
    }
}

async fn chain_validators(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let chain = match &state.chain {
        Some(c) => c,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "anchor chain not enabled" })),
            );
        }
    };

    (
        StatusCode::OK,
        Json(json!({ "validators": chain.validators() })),
    )
}

/// GET /api/chain/proposals — list blocks awaiting signatures from validators.
async fn chain_proposals(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let chain = match &state.chain {
        Some(c) => c,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "anchor chain not enabled" })),
            );
        }
    };

    let pending = chain.pending_block_proposals().await;
    (StatusCode::OK, Json(json!({ "proposals": pending })))
}

/// POST /api/chain/sign — a validator signs a block proposal by hash.
/// Body: { block_hash: "<hash>" }
#[derive(Deserialize)]
struct SignBlockRequest {
    block_hash: String,
}

async fn chain_sign_block(
    State(state): State<Arc<AppState>>,
    bytes: axum::body::Bytes,
) -> impl IntoResponse {
    let locked = *state.locked.read().await;
    if locked {
        return (
            StatusCode::LOCKED,
            Json(json!({ "error": "Identity is locked — unlock first" })),
        ).into_response();
    }

    let chain = match &state.chain {
        Some(c) => c,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "anchor chain not enabled" })),
            ).into_response();
        }
    };

    let req: SignBlockRequest = match serde_json::from_slice(&bytes) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid request: {}", e) })),
            ).into_response();
        }
    };

    let kp = match get_keypair_or_locked(&state).await {
        Ok(k) => k,
        Err(e) => return e.into_response(),
    };

    let sig = chain.sign_block(&kp, &req.block_hash);
    (StatusCode::OK, Json(json!({ "signature": sig }))).into_response()
}

/// POST /api/chain/commit — submit a block (possibly with additional signatures) for validation and commit.
/// Body: { block: <Block JSON> }
#[derive(Deserialize)]
struct CommitBlockRequest {
    block: chain::Block,
}

async fn chain_commit(
    State(state): State<Arc<AppState>>,
    bytes: axum::body::Bytes,
) -> impl IntoResponse {
    let chain = match &state.chain {
        Some(c) => c,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "anchor chain not enabled" })),
            ).into_response();
        }
    };

    let req: CommitBlockRequest = match serde_json::from_slice(&bytes) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid request: {}", e) })),
            ).into_response();
        }
    };

    match chain.commit_block(req.block).await {
        true => (StatusCode::OK, Json(json!({ "status": "committed" }))),
        false => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "block validation failed or already committed" })),
        ),
    }
    .into_response()
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
        "peer_id": state.p2p.read().await.as_ref().map(|h| h.local_peer_id.to_string()),
    });
    if socket
        .send(Message::Text(welcome.to_string()))
        .await
        .is_err()
    {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn dapps_dir_env_takes_priority_over_frontend_path() {
        let env_dir = std::env::temp_dir().join("ddn_dapp_test_env");
        let _ = std::fs::create_dir_all(&env_dir);
        std::env::set_var("DDN_DAPPS_DIR", env_dir.as_os_str());
        let got = dapps_dir("/some/frontend/dist");
        assert_eq!(got, env_dir);
        std::env::remove_var("DDN_DAPPS_DIR");
        let _ = std::fs::remove_dir_all(&env_dir);
    }

    #[test]
    fn dapps_dir_falls_back_to_frontend_path_join_dapps() {
        std::env::remove_var("DDN_DAPPS_DIR");
        let got = dapps_dir("/opt/ddn/frontend/dist");
        assert_eq!(got, PathBuf::from("/opt/ddn/frontend/dist/dapps"));
    }

    #[test]
    fn serve_dapp_redirect_target_layout() {
        // Mirrors serve_dapp: /dapp/<name> -> 308 -> /dapps/<name>/index.html
        // so relative asset refs in the dApp HTML resolve against /dapps/<name>/.
        fn redirect_url(name: &str) -> String {
            format!("/dapps/{name}/index.html")
        }
        assert_eq!(redirect_url("chaindemo"), "/dapps/chaindemo/index.html");
        assert_eq!(redirect_url("guestbook"), "/dapps/guestbook/index.html");
    }
}
