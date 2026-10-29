# DDN DApp API Reference — P2P + Blockchain Integration Guide

This document explains **how a decentralized app (dApp) is installed from a `dist` folder**, and the **full node API** that dApps call to read/write data, manage identity, transfer media, and interact with the anchor blockchain.

---

## 1. Installing a dApp from a `dist` folder

### 1.1 The runtime dApp directory

Every DDN node can serve network-distributed dApps from a directory controlled by
the `DDN_DAPPS_DIR` environment variable. This lets operators or users **install a
dApp at runtime** — no node rebuild, no frontend rebuild required.

```
POST /dapp/:name          → 308 redirect → /dapps/:name/index.html
GET  /dapps/<name>/...    → static file serving (index.html, JS chunks, assets)
```

The `serve_dapp` handler (`main.rs:552`) checks:

1. `$DDN_DAPPS_DIR/<name>/index.html` (if `DDN_DAPPS_DIR` is set — highest priority)
2. `<frontend_path>/dapps/<name>/index.html` (the Vite `build:dapps` output)

If neither exists, the node returns a `404` with a helpful message.

### 1.2 Installing a dApp from a pre-built `dist`

Given a dApp that was built with Vite (outputting `index.html`, `index-HASH.js`,
`assets/`):

```bash
# Option A: runtime install (no node restart needed beyond env var set at start)
export DDN_DAPPS_DIR=/home/user/ddn-dapps
cp -r mydapp-dist /home/user/ddn-dapps/myguestbook

# The node now serves it immediately:
#   GET /dapp/myguestbook  →  redirect to /dapps/myguestbook/index.html
```

```bash
# Option B: built-in dApp (requires `npm run build:dapps` + node restart)
cp -r mydapp-dist frontend/dist/dapps/myguestbook
cargo run --release  # node serves from <frontend_path>/dapps/
```

### 1.3 dApp manifest (optional convention)

A dApp can optionally ship a `manifest.json` at its root. The node does **not**
require it, but the **DApp Manager UI** (if enabled — see Question 5) reads it:

```json
{
  "name": "myguestbook",
  "title": "Guestbook",
  "version": "1.0.0",
  "description": "Public message board",
  "icon": "icon-128.png",
  "routes": ["/"],
  "permissions": ["read:wall", "write:records", "upload:blobs"]
}
```

### 1.4 dApp → node API routing

dApps load as standalone HTML+JS pages. They call the same REST/WebSocket API as
the main frontend — there is no separate dApp API. A dApp just needs to know the
node's base URL:

```javascript
// In a dApp served at /dapp/myguestbook
const API = typeof window !== 'undefined'
  ? (window.localStorage.getItem('ddn_node_url') || '')
  : '';

const base = API ? API : window.location.origin;
const resp = await fetch(`${base}/api/wall`);
```

When served from the node (`/dapp/:name`), `window.location.origin` is
`http://127.0.0.1:<port>`, which is the correct node address.

### 1.5 DApp Manager UI (proposed frontend feature)

To let a **user** set up a dApp from a `dist` on their machine, the Tauri app can
expose a "DApp Manager" page that:

1. Calls `window.api.chooseFile()` (Tauri dialog plugin) to let the user pick a
   `dist` folder.
2. Copies the folder to `$DDN_DAPPS_DIR/<name>/`.
3. If `DDN_DAPPS_DIR` wasn't set, writes it into `config.json` and restarts the
   sidecar node.
4. Shows the dApp at `http://127.0.0.1:<port>/dapp/<name>` (or embeds it in a WebView).

> This requires either a **new node endpoint** (`POST /api/dapps/install`) that
> copies a folder at runtime, or a Tauri-side config change + sidecar restart.
> See **Question 5** below.

---

## 2. Full Node API Reference

All endpoints are relative to `http://127.0.0.1:<DDN_HTTP_PORT>` (default `3000`).

### 2.1 Identity & Key Management

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/identity` | Returns `{ pubkey, locked, auto_unlock? }`. If no identity exists, the node auto-creates one (unlocked) on first start. |
| `DELETE` | `/api/identity` | Deletes the current identity file. Returns `{ status: "deleted", requires_restart: true }`. Node must be restarted to generate a new identity. |
| `POST` | `/api/identity/backup` | Body: `{ password }`. Exports encrypted identity to `{ pubkey }.json`. Returns `{ file: IdentityFile, pubkey }`. |
| `POST` | `/api/identity/export` | Alias for `/backup`. Returns the same `IdentityFile` JSON. |
| `POST` | `/api/identity/import` | Body: `{ file: IdentityFile, password }`. Imports an identity from backup. If the current identity differs, returns `{ status: "imported", pubkey, requires_restart: true }`. |
| `POST` | `/api/identity/restore` | Alias for `/import`. |
| `POST` | `/api/identity/unlock` | Body: `{ password }`. Unlocks the node's identity (needed for signing records, anchoring, etc.). Returns `{ pubkey, locked: false }`. |

**`IdentityFile` schema:**
```json
{
  "version": 1,
  "format": "ddn-identity-v1",
  "pubkey": "ed25519_pubkey_hex",
  "created_ms": 1728900000000,
  "encrypted": {
    "encrypted_secret": "aes_gcm_ciphertext_hex",
    "salt": "hex",
    "cipher": "AES-256-GCM",
    "kdf": { "alg": "PBKDF2-SHA256", "iterations": 100000 }
  }
}
```

### 2.2 Records — Post, Sign, Verify, Fetch

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/record/sign` | Body: `{ type, author, prev, ts, payload }`. Signs a record with the node's key. Returns the full signed `BaseRecord`. |
| `POST` | `/api/record` | Body: full signed `BaseRecord`. Verifies signature, stores in CAS, gossips via Gossipsub. Returns `{ id }`. |
| `GET` | `/api/record/:id` | Fetch a single record by ID (CID). Returns the full `BaseRecord`. |
| `GET` | `/api/records` | List all records known to this node. Returns `{ records: [{ id, type, author, ts }] }`. |
| `GET` | `/api/wall` | Returns all `post`-type records sorted by timestamp (newest first). Returns `{ posts: BaseRecord[] }`. |

**Record structure:**
```json
{
  "id": "<sha256_cid>",
  "type": "post | comment | reaction | message | media_offer | report | mod_action | mod_grant | community | community_membership",
  "author": "<ed25519_pubkey_hex>",
  "prev": "<cid_or_null>",
  "ts": 1728900000,
  "payload": { ... },
  "sig": "<ed25519_signature>"
}
```

**Signing flow (2-step):**
1. `POST /api/record/sign` → node signs with its key → returns `{ id, type, author, prev, ts, payload, sig }`
2. `POST /api/record` → node verifies `sig`, stores, gossips → returns `{ id }`

**Post payload format:**
```json
{ "text": "Hello world 👋", "media": [{ "cid": "<blob_cid>", "mime": "image/png", "size": 1024 }] }
```

### 2.3 Blob Storage (CAS — Content-Addressed Store)

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/blob` | Body: raw bytes (any mime type). Stores in CAS. Returns `{ cid }`. Max 5 MB (`MAX_BLOB_SIZE`). |
| `GET` | `/api/blob` | List all blob CIDs. Returns `{ blobs: string[] }`. |
| `GET` | `/api/blob/:cid` | Fetch blob bytes by CID. Returns raw bytes or `404`. |

**Important:** Blobs are stored locally and are **not** automatically synced via
`/api/sync` (which only syncs records). Cross-node blob transfer uses the
**WebRTC data channel** flow (see §2.6) or manual `/api/blob/:cid` fetch if the
blob exists on the peer.

### 2.4 Peer Network & Sync

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/peers` | Body: `{ url: "http://127.0.0.1:3000" }`. Add an HTTP peer for manual sync fallback. |
| `GET` | `/api/peers` | List configured manual peers. Returns `{ peers: string[] }`. |
| `POST` | `/api/sync` | Pull all records from known peers (HTTP fallback + Gossipsub bootstrap). Returns `{ added: number }`. |
| `GET` | `/api/network` | Network status. Returns `{ enabled, peer_id, listen_addrs, connected_peers, manual_peers, reason? }`. |
| `POST` | `/api/network/connect?addr=/ip4/.../tcp/.../p2p/...` | Connect to a libp2p peer via multiaddr. |

### 2.5 WebSocket Event Stream

```
GET /ws/events (WebSocket upgrade)
```

The server sends JSON messages:

```json
{ "type": "hello", "pubkey": "...", "peer_id": "..." }
{ "type": "record", "record": { ... } }       // locally created or accepted
{ "type": "gossip", "source": "...", "record": { ... } }  // from another peer
{ "type": "webrtc_signal", "source": "...", "data": "..." }
```

### 2.6 WebRTC Media Transfer

For large files (> 5 MB) or peer-to-peer transfer:

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/media/offer` | Body: `{ to: <recipient_pubkey>, file_name, size_bytes, ephemeral_pubkey }`. Creates a media offer record. |
| `POST` | `/api/media/accept` | Body: `{ offer_cid, ephemeral_pubkey }`. Accept a media offer, returns `{ id }`. |
| `POST` | `/api/media/keypair` | Returns `{ pubkey, secret }` for a new WebRTC signaling keypair. |
| `POST` | `/api/webrtc/signal` | Body: `{ payload: "<base64_json>" }`. Relay WebRTC SDP/answer/candidate between peers via the node. |
| `GET` | `/api/dm` | Fetch DMs sent to or from the current identity. Returns `{ messages: BaseRecord[] }`. |

### 2.7 E2EE Direct Messages (X25519 + AES-GCM)

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/dm/seal` | Body: `{ author, to, plaintext }`. Encrypts `plaintext` for `to` using X25519 + AES-GCM. Returns `{ ciphertext, nonce, ephemeral_pubkey }`. |
| `POST` | `/api/dm/open` | Body: `{ ciphertext, nonce, ephemeral_pubkey, sender }`. Decrypts a sealed DM. Returns `{ plaintext }`. |

The encrypted message is stored as a `message`-type record:
```json
{ "to": "<recipient_pubkey>", "ciphertext": "...", "nonce": "...", "ephemeral_pubkey": "..." }
```

### 2.8 Moderation

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/moderation` | Returns `{ blocked_cids, hidden_cids, mod_pubkeys, communities: { [cid]: CommunityInfo } }`. |
| `POST` | `/api/report` | Body: `{ target_cid, reason }`. Submit a moderation report. Returns `{ id }`. |

**CommunityInfo schema:**
```json
{
  "cid": "community_record_cid",
  "name": "Community Name",
  "founder": "ed25519_pubkey",
  "moderators": ["pubkey1", "pubkey2"],
  "blocked_cids": ["cid1", ...],
  "hidden_cids": ["cid2", ...]
}
```

**mod_action record payload:**
```json
{ "target_cid": "<record_to_act_on>", "action": "hide|nuke", "mod_pubkey": "...", "community_cid": "..." }
```

### 2.9 Communities

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/community` | Body: `{ name, description }`. Creates a community record (signer becomes founder-moderator). Returns `{ id, record }`. |
| `GET` | `/api/community` | Lists all known community records. Returns `{ communities: BaseRecord[] }`. |
| `POST` | `/api/community/membership` | Body: `{ community_cid, target_pubkey, role }`. Grants a role (e.g. `"moderator"`) to a member. Returns `{ id, record }`. |

### 2.10 Anchor Blockchain (PoS Anchor Chain)

> Requires `DDN_ENABLE_CHAIN=1` at node startup.

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/chain/anchor` | Submit an AnchorTx. Body: `{ author, record_cid, ts, sig, payload?, media_cid_only?, encrypted?, community_cid?, to? }`. Returns `202` + `{ status: "anchoring" }` (queued) or `201` (committed). |
| `GET` | `/api/chain/block/:height` | Fetch block at height. Returns `{ block: { header, txs } }`. |
| `GET` | `/api/chain/block/latest` | Latest committed block. |
| `GET` | `/api/chain/record/:cid` | Index lookup. Returns `{ cid, height, committed }`. |
| `GET` | `/api/chain/validators` | List validator pubkeys. Returns `{ validators: string[] }`. |
| `GET` | `/api/chain/votes/:height` | Validator signatures for a block (proof of 2/3 quorum). |
| `GET` | `/api/chain/index?...` | Light index: `?dapp=<tag>&community_cid=<cid>&author=<pubkey>&encrypted=<bool>`. |
| `GET` | `/api/chain/proof/:cid` | Merkle proof for a record_cid against a recent block. |
| `POST` | `/api/chain/verify` | Verify an AnchorTx signature without anchoring. |

**AnchorTx layout:**
```rust
struct AnchorTx {
    author: String,            // Ed25519 pubkey of the record author
    record_cid: String,        // SHA-256 CID of the DDN record (the notary anchor)
    ts: u64,                   // Unix seconds
    sig: String,               // Ed25519 sig by `author` over (record_cid || ts)
    // Content mode (one of these):
    payload: Option<Value>,     // full payload for small/public records
    media_cid_only: bool,       // true => payload is in CAS only (media case)
    encrypted: Option<EncryptedEnvelope>,  // private records
    community_cid: Option<String>,         // community-scoped
    to: Option<String>,                     // recipient pubkey for u2u private
}
struct EncryptedEnvelope {
    ciphertext: String,
    nonce: String,
    ephemeral_pubkey: String,
}
```

**Block layout:**
```rust
struct Block {
    header: BlockHeader { height, parent_hash, timestamp, proposer, merkle_root, nonce, hash },
    txs: Vec<AnchorTx>,
}
```

**Two-step anchoring flow (dApp code):**

```javascript
// 1. Create + submit the DDN record (gossip to peers)
const signed = await fetch(`${API}/api/record/sign`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'post', author: pubkey, prev: null, ts: Date.now(),
    payload: { text: 'Hello chain!', dapp: 'mydapp' } })
}).then(r => r.json());

const submitted = await fetch(`${API}/api/record`, {
  method: 'POST',
  body: JSON.stringify(signed)
}).then(r => r.json());

// 2. Anchor the record to the chain
await fetch(`${API}/api/chain/anchor`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    author: signed.author,
    record_cid: submitted.id,
    ts: Math.floor(signed.ts / 1000),
    sig: signed.sig,
  })
});
```

### 2.11 Static File Serving

| Route | Description |
| :--- | :--- |
| `GET /` | Serves `index.html` from the frontend dist. |
| `GET /static/*` | Serves files from `<frontend_path>/` (dist directory). |
| `GET /assets/*` | Serves files from `<frontend_path>/assets/`. |
| `GET /dapps/*` | Serves built dApp files from `<frontend_path>/dapps/`. |
| `GET /dapp/:name` | Redirects to `/dapps/:name/index.html`. |
| `GET /dapp/guestbook` | Standalone guestbook page (inline HTML in the node). |

### 2.12 Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `DDN_HTTP_PORT` | `3000` | HTTP/WebSocket API port. |
| `DDN_P2P_PORT` | `4001` | libp2p listen port. |
| `DDN_DATA_DIR` | `./data` | Node data directory (identity, CAS, chain state). |
| `DDN_FRONTEND_PATH` | (auto-detect) | Path to the frontend `dist/` or source `index.html`. |
| `DDN_ENABLE_CHAIN` | (unset) | Set to `1` to enable the anchor blockchain. |
| `DDN_VALIDATORS` | (self only) | Comma-separated validator pubkeys for PoS. |
| `DDN_DAPPS_DIR` | (unset) | Override directory for runtime dApp installation. |
| `DDN_AUTO_UNLOCK` | (unset) | Set to password for auto-unlocking identity on startup. |

---

## 3. dApp Integration Patterns

### 3.1 Public dApp (e.g. Guestbook)

- Create a `post` record with `payload.dapp = "mydapp"`.
- Read the wall via `GET /api/wall`, filter by `payload.dapp`.
- No encryption — anyone can read.

### 3.2 Private dApp (e.g. Notes)

- Encrypt the payload **client-side** using `POST /api/dm/seal` (reuse the DM crypto).
- Store the ciphertext in a `post` record with `payload.dapp = "notes"`.
- Decrypt using `POST /api/dm/open` when displaying.
- The node never sees plaintext.

### 3.3 Community-scoped dApp

- Use `community_cid` in the `post` payload.
- Members are verified via `/api/moderation` (the `communities` map includes
  `moderators` arrays).
- Moderation (`mod_action` records with `action: "hide"`) applies to
  community-scoped records.

### 3.4 Blockchain-backed dApp

- Submit records normally (gossip), then anchor the CID via
  `POST /api/chain/anchor`.
- Query inclusion via `GET /api/chain/proof/:cid` and verify the Merkle proof.
- For privacy: use the `encrypted` envelope (pubkey-targeted or community-key).
- Use `GET /api/chain/index?dapp=<name>` for efficient filtering.
