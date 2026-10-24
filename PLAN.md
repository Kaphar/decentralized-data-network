


# Decentralized Data Network - Architecture & Implementation Plan (Prototype B)

## 1. Core Principles
- **True Decentralization**: No central server, no single point of failure. Nodes are equal peers.
- **End-to-End Encryption (E2EE)**: Private data (DMs, private media) is encrypted *client-side* before it ever touches a node. Nodes only store and route ciphertext.
- **User Sovereignty**: Users own their cryptographic keys. There is **no admin password reset**. Loss of the local key file and password means permanent loss of that specific identity and its private data.
- **Scalable by Design**: Built on `libp2p` primitives (DHT, Gossipsub) to support a large, open network, avoiding the bottlenecks of manual peer lists or HTTP polling.

---

## 2. Technology Stack Choices

| Function | Technology / Protocol | Rationale |
| :--- | :--- | :--- |
| **Node Backend** | **Rust** (`tokio`, `axum`) | High performance, memory safety, excellent `libp2p` ecosystem (`libp2p-rust`). |
| **Frontend** | **SolidJS + TypeScript + Pure CSS** | Fast, reactive, type-safe, minimal bundle size. No heavy framework overhead. |
| **Identity & Signing** | Ed25519 (via `ed25519-dalek`) | Fast, secure, standard for decentralized identity (`did:key`-style). |
| **Key Management** | Local password (Argon2/PBKDF2) + Exportable `.json` key file | Prevents admin backdoors. User is solely responsible for backup. |
| **Networking & Discovery** | **libp2p** (Kademlia DHT + Gossipsub + mDNS) | Enables organic peer discovery and efficient, real-time pub/sub. |
| **Storage (Small Data)** | Custom Content-Addressed Store (CAS) | Simple, dependency-light storage for text/JSON records. Hash = Address (`sha256`). |
| **Storage (Large Media)** | **WebRTC Data Channels** | Bypasses node storage entirely. Native DTLS-SRTP encryption. Ideal for short videos/large files. |
| **Private Chat (DMs)** | X25519 Key Exchange + AES-GCM (or `crypto_box`) | Ensures nodes only ever see ciphertext. |

---

## 3. Local Architecture & Project Structure

Browsers cannot open raw TCP/UDP sockets for P2P networking. We use a **Local Gateway Model**:
1. **The Rust Node (The Engine)**: Runs `libp2p`, holds the user's identity, handles all signing/encryption, and runs a local HTTP/WebSocket server (`axum`).
2. **The SolidJS Frontend (The UI)**: Runs in the browser, talks *only* to the local Rust node via local HTTP/WebSocket. It focuses purely on UI and state management.

### Proposed Monorepo Structure
```text
decentralized-data-network/
├── PLAN.md                 # This architecture document
├── node/                   # The Rust Backend
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs         # Axum HTTP server + libp2p swarm initialization
│       ├── p2p/            # libp2p behaviors (gossipsub, kad, mdns)
│       ├── crypto/         # Ed25519 signing, X25519/AES-GCM encryption
│       ├── storage/        # The local Content-Addressed Store (CAS)
│       └── records/        # Rust structs for the JSON schemas
├── frontend/               # The SolidJS Frontend
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.tsx        # SolidJS entry point
│       ├── App.tsx         # Root component
│       ├── components/     # UI components (Post, Comment, Chat)
│       ├── api/            # Functions to call the local Rust node
│       ├── styles/         # Pure CSS files
│       └── types.ts        # TypeScript interfaces matching Rust records
└── scripts/                # Helper scripts (e.g., generating test keys)




## 4. Data Model: Record Schema

Every piece of data is a signed, hash-linked JSON record. The id is the SHA-256 hash of the canonicalized JSON (excluding the sig field).

### Base Record Structure

```json
{
  "id":      "<sha256_cid_of_this_record>",
   "type":    "profile | post | comment | reaction | message | media_offer | media_accept | report | mod_action | mod_grant | community | community_membership",
  "author":  "<ed25519_pubkey_multihash>",
  "prev":    "<cid_of_authors_previous_record_or_null>",
  "ts":      1728900000,
  "payload": { ... },
  "sig":     "<ed25519_signature_over_id>"
}
```

### Payload Extensions

| Type | Payload |
| :--- | :--- |
| post | `{ "text": "...", "media": [ { "cid": "...", "mime": "image/jpeg", "size": 1024 } ] }` (Media < 2MB stored encrypted in CAS) |
| comment | `{ "target_cid": "<cid_of_post>", "text": "..." }` |
| reaction | `{ "target_cid": "<cid_of_post_or_comment>", "emoji": "👍" }` |
| message (E2EE DM) | `{ "to": "<recipient_pubkey>", "ciphertext": "<base64>", "nonce": "<base64>", "ephemeral_pubkey": "<x25519_pubkey>" }` |
| media_offer (Large file via WebRTC) | `{ "target_user": "<recipient_pubkey>", "file_name": "video.mp4", "size_bytes": 15000000, "ephemeral_pubkey": "<x25519_pubkey>" }` |
| media_accept | `{ "offer_cid": "<cid_of_media_offer>", "ephemeral_pubkey": "<x25519_pubkey>" }` (Triggers WebRTC handshake) |
| report | `{ "target_cid": "<cid_of_content>", "reason": "explicit_content" }` |
| mod_action | `{ "target_cid": "<cid_or_ip_or_cidr>", "action": "hide" | "nuke" | "ip_ban", "mod_pubkey": "<pubkey>", "duration_secs": <optional, for ip_ban> }` |
| mod_grant | `{ "new_mod_pubkey": "<pubkey>", "signed_by": "<admin_pubkey>" }` |
| community | `{ "name": "Tech Talk", "description": "...", "creator": "<creator_pubkey>" }` (author = founder-moderator, record id = community_cid) |
| community_membership | `{ "community_cid": "<cid>", "target_pubkey": "<pubkey>", "role": "moderator" }` (signed by founder or existing community mod) |
## 5. Key Management & Security Flow

The "No Admin Reset" Rule: To maintain true E2EE, the server/admin must never possess the user's private key.

- **Onboarding**: User enters a local password. The browser/node generates an Ed25519 keypair.
- **Encryption**: The private key is encrypted locally using a key derived from the password (via Argon2 or PBKDF2). Currently uses PBKDF2-HMAC-SHA256 (600k iterations) as it requires no native dependencies.
- **Mandatory Backup**: The app forces the user to download `ddn_backup.json` (containing the encrypted private key and salt). The app will not proceed without this download.
- **Login**: User provides the `.json` file and password. The client decrypts the key in memory. The plaintext key never leaves the local environment.
- **Loss Scenario**: If the user loses both the file and the password, the account is permanently unrecoverable. The admin can only assist in creating a new account.

### 5.1 Current Identity (Key) Handling — Issue

As of Phase 2, the identity handling has a critical limitation:

**The node generates a new random Ed25519 keypair on every startup.** In `main.rs:112`:
```rust
let keypair = Arc::new(crypto::Keypair::generate());
```
`Keypair::generate()` in `crypto/mod.rs:14-20` fills 32 bytes from `OsRng` (cryptographic random) and derives the Ed25519 keypair. There is **no loading from disk** — every node restart produces a completely new identity (new pubkey/CID).

This means:
1. **All browsers connecting to the same running node see the same identity.** The identity is node-scoped, not browser-scoped. The frontend calls `GET /api/identity` and receives the node's pubkey — it is not per-browser. This is why the same identity appears for every browser testing the same node.
2. **The identity is lost on node restart.** There is no `ddn_keys.json` or equivalent written to `DDN_DATA_DIR`. The `IdentityFile` struct exists (`crypto/mod.rs:150-157`) and the backend has `backup_identity` (`main.rs:291`) and `restore_identity` (`main.rs:319`) endpoints, but:
   - There is no endpoint to **load an identity at startup** — the restore endpoint only returns the decrypted key data, it doesn't wire it into `AppState`.
   - There is **no frontend UI** to upload/import an identity file or switch identities.
   - There is **no persistence** — the key file is generated fresh each time.
3. The `KeyBackup` component (`frontend/src/components/KeyBackup.tsx`) lets you *download* a backup, but it is **useless** because the backing identity is ephemeral.

**Fix (planned — see §5.2):** Persist the identity to `{DDN_DATA_DIR}/ddn_identity.json` on first run. On subsequent startups, load it from disk. Add frontend identity management UI for switching, importing, and removing identities.

### 5.2 Planned: Identity Persistence & Frontend Management

#### Backend (Rust node)

- **First-run**: If no identity file exists at `{DDN_DATA_DIR}/ddn_identity.json`, generate a new `Keypair`, encrypt it with a password-derived key (PBKDF2), and write to disk.
- **Subsequent runs**: If the file exists, load it. If it is password-protected, require the password via a new `POST /api/identity/unlock` endpoint. The node starts with signing/verification disabled until unlocked (gossip and record submission are blocked; blob serving still works for existing content).
- **New API endpoints**:
  - `POST /api/identity/unlock` — submit password, node decrypts private key in memory (never stored plaintext).
  - `POST /api/identity/export` — same as current `backup_identity`, produces `ddn_backup.json`.
  - `POST /api/identity/import` — import an `IdentityFile` from a backup `.json` + password. Writes the loaded identity to `{DDN_DATA_DIR}/ddn_identity.json`, replacing the current one. Requires restart to take effect (the swarm derives its libp2p identity from the Ed25519 secret — see `swarm.rs:103-112`).
  - `DELETE /api/identity` — reset to a fresh identity (delete the file, generate new on next startup).
- **On-disk format**: Reuse the existing `IdentityFile` struct (`crypto/mod.rs:150-157`): `{ version, format, pubkey, created_ms, encrypted: { encrypted_secret, salt, cipher, kdf } }`.

#### Frontend (SolidJS)

- **KeyBackup** component (`frontend/src/components/KeyBackup.tsx`): keep existing export/download flow.
- **New IdentityManager** component:
  - Display current identity (pubkey/CID, truncated).
  - **Import**: file input for `ddn_backup.json` + password field. Calls `POST /api/identity/import`. Shows success/error. Requires node restart.
  - **Switch**: if the node stores multiple identities (future), a dropdown to select which identity file to load on next startup. For Phase 2, only one identity file is stored at a time, so "switch" = import a different file.
  - **Remove**: button to delete the identity file (`DELETE /api/identity`), generating a fresh one on next start.
- Wire into the `Backup` tab alongside the existing `KeyBackup` component.

### 5.3 Identity & libp2p PeerId

The libp2p `PeerId` is derived deterministically from the Ed25519 secret via `derive_libp2p_identity()` in `swarm.rs:103-112`:
```rust
fn derive_libp2p_identity(secret: &[u8]) -> identity::Keypair {
    let mut hasher = Sha256::new();
    hasher.update(b"ddn-libp2p-ed25519-v1");
    hasher.update(secret);
    let seed: [u8; 32] = hasher.finalize().into();
    // ... Ed25519 from seed
}
```
This means: **once the Ed25519 identity is persisted, the libp2p PeerId also persists across restarts.** This is desirable — peers can use a stable multiaddr with `PeerId`. The swarm consumes the keypair via `spawn_swarm(secret, ...)` (`main.rs:134`), which receives `keypair.secret_bytes()` (`main.rs:113`).

## 6. Moderation & Governance Model

Since we cannot cryptographically force a node to delete data it already has, moderation is enforced via visibility control and routing refusal.

- **Trusted Moderators**: The client ships with a hardcoded "Admin" public key. The admin can publish `mod_grant` records to promote trusted moderators. Clients maintain a local, cryptographically verified list of active mods.
- **Community Reporting**: Any user can publish a `report` record. This does not hide content; it merely gossips the flag to the network for the moderation team's dashboard.
- **Moderator Action**: A mod reviews reports and publishes a signed `mod_action` record.
- **Enforcement**:
  - **Client-Side**: Clients subscribed to a mod's public key will automatically blur/hide any `target_cid` marked with `action: "hide"`.
  - **Node-Side**: Node operators can configure their software to subscribe to a trusted mod's blocklist. The node will actively refuse to store or serve any blob matching a `nuke` action, protecting the operator from legal liability.
  - **IP Ban (Temporary)**: For emergency situations or abusive nodes, mods can issue `mod_action` records with `action: "ip_ban"` and `duration_secs` in the payload. The node extracts the connecting client's IP from the request, checks it against active IP bans (stored in memory, expiring after `duration_secs`), and returns HTTP 429 (Too Many Requests) for all API endpoints. Supports CIDR notation for IP range bans (e.g., `192.168.1.0/24`). Bans are in-memory only — they expire when the node restarts. The `target_cid` field in the payload carries the banned IP/CIDR string.

## 6.2 Community Model

- **Community Creation**: Any identity can "create" a community by publishing a `community` record type with payload `{ "name": "Tech Talk", "description": "...", "creator": "<creator_pubkey> }`. The creator automatically becomes the community's **founder-moderator**.
- **Community-scoped Moderation**: The creator (and promoted moderators) can issue `mod_action` records scoped to a community by including a `community_cid` field in the payload. These actions (hide, nuke, remove_member) only apply within that community's namespace.
- **Moderator Promotion**: The founder-moderator can publish a `community_membership` record type with payload `{ "community_cid": "<cid>", "target_pubkey": "<pubkey>", "role": "moderator" }` to promote another identity to moderator status *for that community only*. Each community maintains its own local list of trusted moderators.
- **Cross-community Scope**: `mod_action` records without a `community_cid` field retain their global scope (network-level bans from the admin key, as described in §6).

## 7. Media Handling Strategy

- **Small Media** (files ≤ 5 MB): Encrypted client-side → Uploaded to local CAS → CID shared in the post record payload's `media` array.
- **Large Media** (files > 5 MB): Sender generates an ephemeral X25519 keypair (`POST /api/media/keypair`), publishes a `media_offer` record (`POST /api/media/offer` with `target_user`, `file_name`, `size_bytes`, `ephemeral_pubkey`). Recipient replies with `media_accept` (`POST /api/media/accept` with `offer_cid`, `ephemeral_pubkey`). Both clients use the exchanged ephemeral keys to establish a direct WebRTC Data Channel. The encrypted file streams peer-to-peer, bypassing node storage entirely.
- **Broadcast Mode (no WebRTC)**: A frontend checkbox "Don't use WebRTC" forces **all** file uploads through the CAS blob path, regardless of file size. This overrides the 5 MB threshold and uploads the file as a blob to the local node (`POST /api/blob`), storing it on disk and serving it via `GET /api/blob/:cid`. This is simpler and works without WebRTC (no NAT traversal needed), but stores the file on the node's disk. Intended for trusted local networks or when WebRTC is undesirable (e.g., restricted networks, testing).
  - **Implementation**: Add a `useWebRTC` signal (default `true`) in `App.tsx`. Pass it as a prop to `PostForm`. When unchecked, `PostForm.handleFileChange` (`PostForm.tsx:39-68`) always calls `onBlobUpload` regardless of file size, skipping `onMediaOffer`. The `PostForm` component is at `frontend/src/components/PostForm.tsx` and the 5 MB threshold is `MEDIA_CAS_THRESHOLD` at `PostForm.tsx:4`.

## 7.2 Desktop Distribution: Tauri Integration

- **Background Node Process**: Package the Rust node as a sidecar binary that starts on application launch, running in the background without a visible terminal window. The SolidJS frontend runs embedded in a WebView2 (Windows) / WebKit (macOS) / WebKit2GTK (Linux) renderer inside the Tauri window.
- **System Tray Icon** (Windows/macOS): The tray displays:
  - A green/red indicator: green = node is running and libp2p swarm is active + WebSocket connected; red = node stopped or disconnected.
  - Peer count and recent data transfer stats (bytes synced, records published).
- **Tray Menu**:
  - **Toggle Node**: Start/stop the local Rust node sidecar process. Stops all libp2p networking and halts record serving.
  - **Open Main Window**: Launches the full SolidJS UI in a Tauri browser window (served from the embedded frontend).
  - **Settings**: Opens a configuration dialog for `DDN_HTTP_PORT`, `DDN_P2P_PORT`, `DDN_DATA_DIR`, and bootstrap peer addresses. Persisted to a JSON config file in the user's app data directory.
  - **Quit**: Gracefully shuts down the node and exits the application.

## 8. Reactions (Emoji Support)

- **Reaction records**: Use the existing `reaction` record type (`records/mod.rs:11`). Payload: `{ "target_cid": "<cid_of_post_or_comment>", "emoji": "👍" }`.
- **Posting a reaction**: Frontend renders emoji buttons (👍, ❤️, 😄, 😮, 😢, 😡, etc.) on each post and comment card. Clicking an emoji creates a `reaction` record via `POST /api/record/sign` + `POST /api/record` (or directly through `POST /api/record` with a pre-signed record), just like posts/comments.
- **Aggregating reactions**: The node does not index reactions server-side. Instead, the frontend scans all known `reaction` records (received via `GET /api/wall` or `/ws/events` gossipsub) and groups them by `target_cid` + `emoji`. The `PostList` component (`PostList.tsx:115-203`) renders a reaction summary below each post.
- **Self-counting & dedup**: Each `reaction` record is signed, so the frontend can detect a user's own reaction by their pubkey and allow toggling (removing) it. Multiple users can react with the same emoji; the count is the number of distinct `reaction` records for that `(target_cid, emoji)` pair.

## 9. Development & Testing Strategy (No VPS Required)

- **Tier 1 — Local LAN Testing (Zero Config)**: Use `libp2p::mdns` (Multicast DNS). Running multiple Rust nodes on the same local machine/Wi-Fi will automatically discover each other without any bootstrap configuration.
- **Tier 2 — Cross-Internet Testing (Free)**: When testing with external peers, run a dedicated "Bootstrap Node" locally and expose it to the internet for free using Cloudflare Tunnels (`cloudflared`). Hardcode this tunnel address into the Rust node's config as a bootstrap peer.
- **Multi-Node Testing**: Run multiple node instances locally by setting `DDN_HTTP_PORT`, `DDN_P2P_PORT`, and `DDN_DATA_DIR` environment variables. Each instance gets its own identity and frontend URL. Use the in-app "Node URL" input field to point any browser at any running node.

  Example:
  ```sh
  DDN_DATA_DIR=./data1 DDN_HTTP_PORT=3001 DDN_P2P_PORT=4001 cargo run
  DDN_DATA_DIR=./data2 DDN_HTTP_PORT=3002 DDN_P2P_PORT=4002 cargo run
  ```

## 10. Frontend Serving Options

- **Option 1 (Local dev, multi-node)**: The frontend runs in a detached Vite dev server or connects to a node via the "Node URL" input field. This is ideal for development and multi-node testing — a single browser can reach any node by entering its `http://localhost:<port>` address.
- **Option 3 (Embedded frontend per node)**: Each Rust node serves its own copy of the frontend from `dist/` via `ServeDir` (see `main.rs` `serve_frontend`). This makes each node fully self-contained — no separate web server or browser configuration needed. Recommended for production. The frontend is built via `npm run build` and copied to the node's data directory or the path specified by `DDN_FRONTEND_PATH`.

## 10. Phased Roadmap

| Phase | Deliverable | Status | Est. Effort |
| :--- | :--- | :--- | :--- |
| 0 (Prototype A) | Python prototype: basic CAS, hash-linked records, web UI | **Done** | — |
| 0 | Prototype B skeleton: Rust CAS, hash-linked records, SolidJS frontend shell, manual peer config, plaintext posts | **Done** | — |
| 1 | libp2p Integration: Kademlia DHT + Gossipsub + mDNS. Mandatory `.json` key export UX. WebSocket push from node to frontend. Network status + peer connect UI. | **Done** | ~2 weeks |
| 2 | E2EE DMs: X25519 + AES-GCM sealed messaging (`seal_dm`/`open_dm` in Rust). DM encrypt/decrypt API endpoints (`POST /api/dm/seal`, `POST /api/dm/open`). Chat UI uses E2EE. WebRTC `media_offer`/`media_accept` signaling records + API endpoints (`POST /api/media/offer`, `POST /api/media/accept`, `POST /api/media/keypair`). Media threshold: files ≤ 5 MB → CAS, files > 5 MB → WebRTC offer. | **Done** | ~3 weeks |
| 3 | Moderation System: `report`, `mod_grant`, `mod_action` record types. `POST /api/report` endpoint. `GET /api/moderation` endpoint with blocked/hidden CIDs and mod pubkeys. Client-side report UI + moderation panel. Per-post report buttons. Node-level blocked CID enforcement (refuse `GET /api/blob/:cid`, `GET /api/record/:id`, refuse `POST /api/blob`, `POST /api/record` for nuked content). Client-side hide filtering (blur posts with `action: "hide"`). **IP Ban**: `mod_action` with `action: "ip_ban"` + `duration_secs` → in-memory CIDR IP bans, HTTP 429 for banned clients. | **Done** | ~2 weeks |
| 4 | Reactions: `reaction` record type. Emoji buttons on posts/comments in `PostList` + `Chat`. Client-side aggregation of reactions by `target_cid` + `emoji`. Toggle/remove own reactions. | **Done** | ~1 week |
| 5 | Identity Persistence & Management: Save `ddn_identity.json` to `DDN_DATA_DIR` on first run. Load on subsequent startups. `POST /api/identity/unlock`, `POST /api/identity/import`, `DELETE /api/identity` endpoints. New `IdentityManager` frontend component with dropdown action selector for switch/add/remove/import. **Broadcast Mode**: "Don't use WebRTC" checkbox in `PostForm` — overrides 5 MB threshold, forces all uploads through CAS blob path. | **Done** | ~2 weeks |

| 6.2 | **Community Model (Phase A — Minimal)**: `community` record type for creation with `creator` auto-elected as founder-moderator. `community_membership` record type `{ "community_cid", "target_pubkey", "role" }` for promoting moderators per-community. Community-scoped `mod_action` with optional `community_cid` — validated against community moderator sets. `GET /api/communities`, `POST /api/community`, `POST /api/community/membership` endpoints. Client-side merge of global + community-scoped hidden/blocked CIDs. **Done** | ~1 week |

| 6.2b | **Community Model (Phase B — Future)**: Per-community gossipsub topics (`ddn/community/<cid>/v1`) for record isolation and privacy. Community-scoped post filtering (posts carry optional `community_cid`). Full namespace scoping for mod_actions. Community-scoped role hierarchy (admin/moderator/member). Private/invite-only communities with per-community ACLs. | **Planned** | ~2-3 weeks |


PROTOTYPE C :
 **Desktop Distribution (Tauri)**: Package the Rust node as a background sidecar binary. System tray icon with green/red status indicator, peer count, data transfer stats. Tray menu: toggle node on/off, open main window, settings (ports, data dir, bootstrap peers). | **Planned** | ~3 weeks |
 
 * study possibility of Blockchain like lbry. plan some way to access data from a simple data blockchain and some integration within our decentralized webpages.
 
 * select a smart way of handling multiple "dapps" (a diferent webpage). our Wall with post could be a first example, we can set up some other classical simple exemples 