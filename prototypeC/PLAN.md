# Prototype C — Detailed Design

**Focus**: Desktop distribution (Tauri), blockchain anchor chain, and multi-dApp architecture.
Prototype C builds directly on Prototype B's Rust `ddn-node` and SolidJS frontend.

---

## C-1: Desktop Distribution (Tauri)

### Goal

Run the full decentralized network as a desktop application with no terminal window.
The Rust node runs in the background (`libp2p` gossip); the SolidJS UI runs in a
native WebView embedded in a frameless Tauri window. A system-tray icon gives
at-a-glance network status and quick access to controls.

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Tauri window (WebView2 / WebKit) — SolidJS frontend    │
│  http://127.0.0.1:<port>  (talks only to local node)    │
└────────────────────────────────────┬────────────────────┘
                                     │ HTTP / WS
┌────────────────────────────────────▼────────────────────┐
│  ddn-node sidecar (Rust) — libp2p swarm + CAS + API      │
│  Spawned as a child process by the Tauri binary.          │
│  Listens on DDN_HTTP_PORT (default 3000).                 │
└─────────────────────────────────────────────────────────┘
```

### Directory Structure

```text
prototypeC/
├── PLAN.md                 # This file
├── README.md               # Build & run instructions
├── Cargo.toml             # Tauri app crate (the desktop shell)
├── tauri.conf.json        # Tauri configuration (sidecar, tray, windows)
├── src/
│   └── main.rs            # Tauri entry: tray + window + sidecar lifecycle
├── icons/                 # Tray / window app icons (16..512px)
├── frontend/              # Copied/built SolidJS frontend from prototypeB
└── node/                  # Copied prototypeB Rust node (compiled as sidecar)
```

> **Reuse strategy**: The `node/` and `frontend/` directories are initially populated
> by copying or symlinking from `prototypeB/`. A build script copies the frontend
> `dist/` into the Tauri bundle resources and compiles the node as a cargo sidecar.

### Cargo.toml (Tauri shell)

```toml
[package]
name = "ddn-tauri"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = "2"

[dependencies]
tauri = { version = "2", features = ["process", "system-tray"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

### tauri.conf.json — Sidecar configuration

The node is bundled as an external sidecar binary. Tauri's `tauri.bundle.active`
packages it; at runtime `tauri::process::Command::new_sidecar("ddn-node")` spawns it
with `DDN_HTTP_PORT`, `DDN_P2P_PORT`, and `DDN_DATA_DIR` environment variables.

```jsonc
{
  "build": {
    "distDir": "../frontend/dist",
    "devPath": "http://localhost:5173",
    "withGlobalTauri": false
  },
  "package": { "productName": "DDN", "version": "0.1.0" },
  "tauri": {
    "systemTray": {
      "icon": "icons/16x16.png",
      "icon-as-resource": true,
      "tooltip": "Decentralized Data Network"
    },
    "windows": [{ "url": "index.html", "width": 1024, "height": 720 }],
    "bundle": {
      "active": true,
      "identifier": "com.ddn.app",
      "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png"],
      "targets": "msi,dmg,nsis"
    }
  }
}
```

### src/main.rs — System tray + sidecar lifecycle

1. On launch: read persisted config (`%APPDATA%/ddn/config.json` or platform equivalent).
   Defaults: HTTP port 3000, P2P port 4001, data dir = `<app-data>/ddn-data`.
2. Spawn the `ddn-node` sidecar with the configured env vars.
3. Create a hidden main window (shown on demand) that loads the bundled frontend.
4. Build a system-tray icon. Poll `GET /api/network` and `GET /api/identity` on the
   node to update the tray tooltip with peer count + lock status.
5. Tray menu handlers:
   - **Open**: show/unminimize the main window.
   - **Toggle Node**: signal the sidecar to stop; restart it when toggled back on.
   - **Settings**: spawn a settings window (or native dialog) that edits the config
     and restarts the node with the new ports/paths.
   - **Quit**: terminate the sidecar, then exit.
6. The frontend detects it's running inside Tauri (no "node URL" input needed; it
   always targets `http://127.0.0.1:<port>`).

### Build / Run (development)

```bash
# 1. Build the node binary
cd node && cargo build --release

# 2. Build the frontend
cd ../frontend && npm install && npm run build

# 3. Run the Tauri shell (cargo)
# Run the Tauri shell in development
cd prototypeC && cargo run
```

### Build / Run (production bundle)

```bash
cargo tauri build
```

---

## C-2: Blockchain Anchor Chain (as a decentralized database)

### Motivation & positioning

This is the user's first blockchain project. Rather than integrating a complex
existing chain (LBRY, Ethereum, etc.), we build a **minimal Proof-of-Stake-style
anchor chain** from scratch in Rust. The chain does **not** replace gossipsub — it
provides a tamper-evident, time-ordered log layered on top of the existing DDN
record store.

**Two key facts that drive the design:**

- The blockchain does **not** certify that a record is "true" or that its content
  is accurate. It certifies **when (block height + timestamp)** a given record CID
  existed, in an append-only, hash-chained log. It is a *notary / timestamp* layer.
- The full record payload (message text, media) is **not** normally stored on
  chain — only a reference (the CID). This is by design: storing everything on
  chain bloats the log and duplicates the CAP store.

The new requirement from the user is to treat the chain as a **decentralized
database** with two access modes: **public** records (readable by anyone who can
see the block) and **locked** records (content encrypted so only holders of a
shared/decryption key can read them).

### Data model decisions (decided)

- **Storage model — hybrid (inline small, CID for media):** AnchorTx carries the
  *full payload data* for records with small payloads (< 100 KB threshold, `MAX_EMBEDDED_PAYLOAD`).
  Records whose payload contains media (> 100 KB) anchor by **CID-only** (the
  `media_cid_only` flag — the payload lives in CAS, only the record_cid is stored
  on-chain).
- **100 KB threshold:** `MAX_EMBEDDED_PAYLOAD = 102400` bytes. Media above this
  threshold is CID-only. This is the same threshold used by `PostForm.tsx` for
  the CAS upload decision.
- **No change to the DDN record itself:** media records still upload blobs to CAS;
  the chain just references them rather than duplicating.
- **Encrypted ("locked") records:** an AnchorTx gains an optional `encrypted`
  envelope. If a post is to be private, the *author encrypts the payload with a
  symmetric key*, sets `encrypted = true`, and stores the ciphertext + nonce + a
  `key_hint` inside the AnchorTx (not the plaintext). The plaintext itself is never
  stored on chain.

### Access control decisions (decided)

Three tiers, chosen per use case:

1. **Public chain records** — default. AnchorTx is stored verbatim; anyone can
   read the block and the payload.
2. **Private user→user messages** — recipient pubkey encryption. The author
   encrypts the payload with the **recipient's X25519 pubkey** (reusing the
   existing `crypto::seal_dm` / `crypto::open_dm` / AES-GCM path from the DM flow).
   The AnchorTx stores `{ciphertext, nonce, ephemeral_pubkey, to: recipient_pubkey}`
   instead of the plaintext payload. Only the recipient (keyed to their node
   identity, i.e. their Ed25519 pubkey) can decrypt.
3. **Community-scoped records with optional encryption** — communities can be
   created with `is_private: true`. When private:
   - A random 32-byte **group key** is generated and stored on the founder's node.
   - The founder retrieves the key via `GET /api/community/key/:cid` and encrypts
     it for each member using X25519+AES-GCM (`seal_dm`).
   - The encrypted key is included in the membership record
     (`POST /api/community/membership` with `encrypted_group_key`).
   - Members decrypt the group key with `open_dm` and use it to encrypt/decrypt
     their own records before posting.
   - The node stores encrypted records only; decryption is always client-side.

### Block / AnchorTx layout (revised)

```rust
/// Maximum size of embedded payload data in an AnchorTx (100 KB).
pub const MAX_EMBEDDED_PAYLOAD: u64 = 5000 * 1024;

struct AnchorTx {
    author: String,        // Ed25519 pubkey (the DDN author / record signer)
    record_cid: String,    // SHA-256 CID of the DDN record (always present, the notary anchor)
    ts: u64,               // Unix seconds
    sig: String,           // Ed25519 sig by `author` over (record_cid || ts)
    // --- payload storage mode (one of these) ---
    payload_data: Option<String>,  // full payload for small public records (< 100 KB)
    media_cid_only: bool,          // true => payload lives in CAS, only CID is stored
    // --- encrypted envelope (only when record is private) ---
    encrypted: Option<EncryptedEnvelope>,
    community_cid: Option<String>,     // for community-scoped records
    to: Option<String>,                 // recipient pubkey for u2u private messages
}

struct EncryptedEnvelope {
    ciphertext: String,
    nonce: String,           // hex AES-GCM nonce
    ephemeral_pubkey: String, // X25519 ephemeral, for u2u case
}

struct BlockSignature {
    validator_cid: String,   // pubkey CID of the signing validator
    signature: String,       // hex-encoded Ed25519 signature of the block hash
}

struct Block {
    header: BlockHeader,     // height, parent_hash, timestamp, proposer, merkle_root, nonce, hash
    txs: Vec<AnchorTx>,
    signatures: Vec<BlockSignature>,  // validator signatures (2/3+1 needed to commit)
}
```

Notes:
- `record_cid` is **always** stored — this is the notary proof and the index key.
- The embedded `payload` / `encrypted` envelope is optional convenience for
  self-contained verification (a verifier can check the AnchorTx `sig` without
  fetching the CAS record, as long as the payload is inline).
- `media_cid_only` is a hint that the payload lives in CAS (the verifier must fetch
  the CID to see it); it is equivalent to "payload is nil."

### Consensus (implemented)

- A configurable **validator set**. Genesis = the node's own identity. The set is
  read from `DDN_VALIDATORS` (comma-separated pubkey CIDs) at startup if set;
  otherwise it is just the genesis validator.
- **Block signatures + 2/3 supermajority**: Each block has a `signatures` field
  (`Vec<BlockSignature>`). A validator signs a block proposal via
  `POST /api/chain/sign`. A block is committed only when it has ≥ `2/3+1` valid
  signatures from the validator set:
  - Single validator: 2/3 of 1 = 1, so the genesis validator self-signs and commits immediately.
  - Multi-validator: the proposer signs, other validators sign, block is committed when quorum is reached.
- **2/3 threshold formula**: `ceil(n * 2/3) + 1` where `n = validators.len()`.
- **Round-robin proposer**: `validators[height % n]` is the proposer for each height.
- **Proposal/sign/commit flow**:
  1. Proposer builds a block via `propose_block()` (does not commit yet).
  2. Proposer self-signs and broadcasts.
  3. Other validators call `POST /api/chain/sign` to add their signature.
  4. Once ≥ 2/3+1 signatures, any node calls `POST /api/chain/commit` to finalize.
  5. The producer loop (`start_producer`) checks for quorum every 10 seconds and commits automatically.
- **Finality**: A committed block in `chain_state.json`.

### Producer / finality timing

`start_producer(10)` still drives a 10-second `tokio::time::interval`. The changed
rule: a block is produced on a tick if there is **≥1 pending AnchorTx**, then it
runs the vote/commit step above before appending. So finality is still
**time-driven (10 s) + ≥1 queued tx**, now gated behind the 2/3 commit. No PoW;
`nonce` carries the height; proposer is round-robin.

### API (revised)

The anchor chain runs as a new Rust module `node/src/chain/` integrated into
`main.rs`. Existing endpoints gain fields; new endpoints are added for the
database-style queries.

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/chain/anchor` | Submit an AnchorTx (CID-only). Body: `{author, record_cid, ts, sig}`. Returns `202` + `"anchoring"` (queued). |
| `POST` | `/api/chain/anchor-payload` | Submit an AnchorTx with **embedded payload data** (for records < 100 KB). Body: `{author, record_cid, ts, sig, payload_data, content_type}`. Returns `202` + `"anchoring"`. `413` if payload > 100 KB. |
| `POST` | `/api/chain/proposals` | **New.** List blocks awaiting validator signatures. Returns `{ proposals: Block[] }`. |
| `POST` | `/api/chain/sign` | **New.** Validator signs a block proposal. Body: `{ block_hash }`. Returns `{ validator_cid, signature }`. |
| `POST` | `/api/chain/commit` | **New.** Submit a signed block for validation and commit. Body: `{ block }`. |
| `GET`  | `/api/chain/block/:height` | Fetch block at height. Returns `{ block: { header, txs, signatures } }`. |
| `GET`  | `/api/chain/block/latest` | Latest committed block. |
| `GET`  | `/api/chain/record/:cid` | Index lookup: returns `{cid, height, committed: bool}`. |
| `GET`  | `/api/chain/validators` | List current validator pubkeys. |
| `GET`  | `/api/chain/votes/:height` | Validator signatures for a block (proof of 2/3 quorum). |
| `GET`  | `/api/chain/index?dapp=x&community_cid=y` | Light node-side index over committed AnchorTxs. |
| `GET`  | `/api/chain/proof/:cid` | Merkle proof for a record_cid against a recent block. |

### Querying & filtering (decided)

Choice **(c) Merkle proofs + a light off-chain index**. Rationale:

- On-chain indexing is expensive and bloats the chain.
- A pure light-client scan (`/api/chain/block/{h}`) is always possible and is the
  trustless baseline, but it requires fetching every block from genesis.
- Therefore the node exposes a **best-effort index** (`/api/chain/index?...`) and a
  **Merkle proof** (`/api/chain/proof/:cid`) so clients can verify inclusion cheaply
  without re-scanning history. If the index disagrees with a scan, trust the scan.
- The index is **not** a source of truth; proofs are.

Filterable AnchorTx fields for the index: `dapp` (string tag in payload), `community_cid`,
`author`, and `encrypted` (boolean). Public records are returned fully; encrypted
records return only the envelope + metadata (nonce, ciphertext, `to`/`community_cid`) —
the decryption key is never served by the node.

### DApp model alignment

From C-3 (routing):

- **Main UI tabs** (inside the Tauri WebView / app): `Wall | Network | Chat | Peers | Files | Chain | Blockchain | Settings`.
  - `Chain` = existing anchor tab (per-record anchor status, latest block, anchor a post).
  - `Blockchain` = the new standalone chain-as-database view (full history, Merkle proofs, light queries). Implemented as `ChainDemo.tsx` in the prototype frontend.
- **Network-distributed dApps** (served by the node, browser/external WebView):
  `/dapp/guestbook` (public, `payload.dapp === 'guestbook'`), `/dapp/notes` (planned,
  client-side encrypted, `payload.dapp === 'notes'`).
- A record on the **Wall** (gossip) is public to connected peers; it may or may not
  be anchored. A record on the **Chain** is timestamped/immutable on that node and
  optionally encrypted + filtered via the chain index. A single record can be both:
  posted to the Wall *and* anchored.

### Security & limitations (explicit, non-preachy)

- The chain authenticates **who signed** (Ed25519 over `record_cid || ts`) and
  orders entries; it does **not** validate content truth, spam, or duplicates
  beyond signature verification.
- Single-node deployments have no distributed finality; a block committed on your
  node is final *on your node*.
- Encrypted records are only as private as your encryption key handling; the node
  stores ciphertext but never the decryption key.
- `media_cid_only` / inline-payload choice is author-controlled and not enforced.

### Integration with DDN

- A node opt-in flag `DDN_ENABLE_CHAIN=1` runs the anchor chain (unchanged).
- The node can **auto-anchor** new records it gossips, configurable per-record type
  and per-dapp, off by default. (Unchanged.)
- Frontend `Chain` and `Blockchain` tabs both exist in the main app (chain is a core
  network feature, not a user dApp).

---

### Deferred (not in this phase)

- Cross-node block syncing (only the single node's `chain_state.json` is authoritative).
- Community key derivation for encrypted community records (the group key is
  a random symmetric key distributed via encrypted membership records — no KDF).
- `/api/chain/index`, `/api/chain/proof/:cid`, `/api/chain/verify`, `/api/chain/votes/:height`
  endpoints are planned but not yet implemented (the frontend has wrappers for them;
  they'll be added when the chain database view is finalized).
- Using the chain as the canonical CAS (it is a notary/index layer, not the content
  store).


---

## C-3: Multi-DApp Architecture

### Goal

Let the same local node + desktop shell host multiple decentralized apps. The Wall
is the first; we add a **Guestbook** as a demo.

### Architecture Decision: Embedded UI vs Network-Distributed dApps

**Decision**: The main Tauri WebView window shows the **home app** (the Wall / network
status / identity management). dApps like Guestbook are served **directly by the node**
at a URL path (e.g. `http://localhost:3000/dapp/guestbook`), accessible either through
a browser or potentially embedded as a second WebView.

**Open question for the user**: Should the Tauri shell:
1. Show only the home app (Wall/settings) in the main window, and let users open
   dApps (Guestbook, Notes, etc.) in an external browser?
2. Show the home app AND provide tabs to switch to embedded dApp WebViews within
   the same Tauri window?
3. Show only dApp WebViews (no home UI), delegating everything to the network?

For now, the **Blockchain** tab lives inside the main app (since it's a core network
feature, not a user dApp), while Guestbook is served as a standalone page by the node
at `/dapp/guestbook`.

### Routing

- **Main UI** (inside the Tauri WebView / single-page app in `src/main.tsx` + `App.tsx`):
  `Wall | Network | Chat | Peers | Files | Settings`. The chain/Blockchain UI has been
  **removed from the main app**; it now lives as a **network-distributed dApp** so the
  main bundle stays small.
- **Network-distributed dApps** (served by the node at `/dapp/<name>`, reachable via
  browser or external WebView):
  - `/dapp/guestbook` — public guestbook (inline HTML in the node).
  - `/dapp/chaindemo` — the blockchain anchor-chain database view, served as a
    standalone built app from `dist/dapps/chaindemo/`.

### dApp packaging model

dApps live in `prototypeB/frontend/src/pages/<name>/` as self-contained folders
(`index.html` + `main.tsx`, optionally co-located css). Each dApp is built
**independently** by `node scripts/build-dapps.js` into `dist/dapps/<name>/` with:

```
dist/dapps/<name>/
├── index.html               # references ./index-<hash>.js + assets/<...>
├── index-<hash>.js          # entry chunk (relative, self-contained)
└── assets/<name>-<hash>.css  # styles
```

The node mounts this tree under `/dapps/` via a single `ServeDir`
(`nest_service("/dapps", ServeDir::new("<frontend>/dapps"))`). The route
`GET /dapp/:name` checks `<dapps_dir>/<name>/index.html` exists and issues a
**308 redirect** to `/dapps/<name>/index.html`; relative asset refs in the HTML
then resolve correctly (e.g. `assets/<name>-*.css` → `/dapps/<name>/assets/...`).

**Adding a dApp (no node rebuild needed):**
1. Drop a folder at `src/pages/<name>/` with `index.html` + `main.tsx`.
2. Run `npm run build:dapps` from `prototypeB/frontend` → outputs
   `dist/dapps/<name>/`.
3. The node serves it at `http://127.0.0.1:3000/dapp/<name>` automatically.

#### Runtime dApp distribution (no frontend rebuild)

Operators/users can install and discover dApps at runtime without a node or
frontend rebuild:

| Endpoint | Description |
| :--- | :--- |
| `GET /api/dapps` | List locally installed dApps. Returns `{ dapps: string[], dir: string }`. |
| `POST /api/dapps/install` | Body: `{ name, source_path }`. Copy a pre-built dist folder into the dApps dir. Requires unlocked identity. Returns `{ status, name, url }`. |
| `POST /api/dapps/dir` | Body: `{ path }`. Change the dApp directory at runtime (no restart). Requires unlocked identity. Returns `{ status, dir }`. |
| `POST /api/dapp/register` | Register a dApp as a gossip record (`payload.kind='dapp'`). Allows network-wide discovery. Requires unlocked identity. |
| `GET /api/dapp/discover` | List all dApp records discovered via gossip. |

The dApp directory is initialized from `DDN_DAPPS_DIR` (env) or
`<frontend_path>/dapps` (fallback), and can be changed at any time via
`POST /api/dapps/dir` — no node restart needed.

**dApp discovery model: Gossip records (integrated)**
- dApps are registered as signed records with `payload.kind='dapp'`.
- The record carries: `name`, `description`, `version`, `url`, `is_encrypted`, `source_cid`.
- Other nodes discover dApps by querying records filtered by type=`dapp`.
- The DApp Manager UI shows both locally installed dApps and network-discovered dApps.
- dApps can be opened in an external browser or an in-app Tauri window (user's choice).
- dApp display: native folder dialog (Browse button) for selecting dist folders.

### Record namespace

DApp records optionally carry a `dapp` field in the payload (e.g.
`{ "dapp": "guestbook", "text": "hello" }`). The guestbook page filters the wall's
records by this field. Existing record types are reused — no new on-chain schema needed.

### DApp: Guestbook (network-distributed)

- Served by the node at `/dapp/guestbook` (a standalone HTML page with inline JS).
- A public, append-only wall scoped to `dapp: "guestbook"`.
- Posting creates a signed `post` record with `payload.dapp = "guestbook"`.
- Anyone can post; anyone can read.
- Filters records from `/api/wall` by the `dapp` field.

### DApp: Notes (planned)

- A private, per-user dApp served by the node at `/dapp/notes`.
- Notes are **encrypted client-side** (X25519 + AES-GCM, reusing the prototypeB DM crypto)
  before being stored/anchored.
- Each note is a `post`-type record with `payload.dapp = "notes"` and the note text
  stored as ciphertext in the payload.
- The node only ever sees ciphertext.

### Shared infrastructure

- The node API is unchanged — dApps are a frontend routing/filtering concern.
- A `dapp` field in the payload provides optional filtering without schema churn.

---

## Implementation Order

1. **C-1 Tauri shell**: scaffold `Cargo.toml`, `tauri.conf.json`, `src/main.rs`
   with system tray + sidecar spawn. Wire settings persistence.
2. **C-1 Frontend integration**: build the prototypeB frontend, bundle into Tauri.
   Ensure the embedded frontend detects localhost-only mode (no node-URL selector).
3. **C-1 Packaging**: `cargo tauri build`, verify sidecar starts, tray updates.
4. **C-2 Chain module**: add `node/src/chain/` (Block with `signatures`, AnchorTx with `payload_data`/`content_type` for embedded payloads, `media_cid_only` for CID-only, validator set from `DDN_VALIDATORS`, 2/3 threshold voting).
   - `POST /api/chain/anchor`, `POST /api/chain/anchor-payload`,
   - `GET /api/chain/block/:height`, `GET /api/chain/block/latest`,
   - `GET /api/chain/record/:cid`, `GET /api/chain/validators`,
   - `GET /api/chain/proposals`, `POST /api/chain/sign`, `POST /api/chain/commit`.
   - `DDN_ENABLE_CHAIN=1` opts in; `DDN_VALIDATORS` configures the validator set.
   - `MAX_EMBEDDED_PAYLOAD = 100 KB` threshold for inline vs CID-only.
5. **C-2 Frontend (as dApp)**: `src/pages/chaindemo/` (`ChainDemo.tsx` + `main.tsx` + `index.html`) — the standalone blockchain database view (full history, signatures, Merkle proofs). Served by the node at `/dapp/chaindemo` via the generic dApp router. Built by `npm run build:dapps`.
6. **C-3 DApp router**: generic `GET /dapp/:name` route serving `<dapps_dir>/<name>/index.html` (308 redirect to `/dapps/<name>/index.html`). Runtime dApp directory changes via `POST /api/dapps/dir`. dApp discovery via gossip records (`POST /api/dapp/register`, `GET /api/dapp/discover`).
7. **C-3 Guestbook dApp**: standalone HTML page served by the node, filters by
   `dapp` field in records.
8. **C-2 Community encryption**: `POST /api/community` with `is_private` flag,
   `GET /api/community/key/:cid` for group key retrieval, `encrypted_group_key`
   in membership records for private communities.

---

## Progress Log

### C-2: Blockchain Anchor Chain (implemented)
- Added the chain module `node/src/chain/` with the hybrid AnchorTx
  (`payload_data` + `content_type` for small inline records, `media_cid_only` for
  media > 100 KB, `encrypted` envelope for private u2u messages).
- **Multi-validator support**: validator set from `DDN_VALIDATORS` env var.
  `Block` struct now includes `signatures: Vec<BlockSignature>`.
  2/3+1 threshold for commit. Round-robin proposer selection.
- **Endpoints**: `POST /api/chain/anchor`, `POST /api/chain/anchor-payload`,
  `GET /api/chain/block/:height`, `GET /api/chain/block/latest`,
  `GET /api/chain/record/:cid`, `GET /api/chain/validators`,
  `GET /api/chain/proposals`, `POST /api/chain/sign`, `POST /api/chain/commit`.
- `DDN_ENABLE_CHAIN=1` opts in; `DDN_VALIDATORS` configures the validator set.
- `MAX_EMBEDDED_PAYLOAD = 100 KB` threshold for inline vs CID-only.
- `ChainDemo.tsx` (standalone `/dapp/chaindemo`): full history, block signatures,
  Merkle proofs, light index queries.

### C-2: Community Encryption (implemented)
- `POST /api/community` now accepts `is_private: bool`. For private communities,
  a random 32-byte group key is generated and stored on the node.
- `GET /api/community/key/:cid` — retrieve the group key (requires unlocked identity).
- `POST /api/community/membership` now accepts `encrypted_group_key` field
  (X25519+AES-GCM sealed group key for private communities).
- Frontend API updated: `createCommunity(name, desc, is_private)`,
  `promoteCommunityModerator(cid, pubkey, role, encrypted_group_key?)`,
  `getCommunityGroupKey(cid)`.

### C-3: Multi-DApp Architecture (implemented)
- **dApp gossip records**: `POST /api/dapp/register` publishes a `dapp`-type
  record (`payload.kind='dapp'`) for network discovery. `GET /api/dapp/discover`
  lists all discovered dApps.
- **Runtime dApp dir**: `POST /api/dapps/dir` changes the dApp directory at
  runtime without node restart. Replaced `nest_service("/dapps", ServeDir::new(...))`
  with a custom `GET /dapps/{*path}` handler that reads from the runtime-swappable dir.
- **dApp Manager UI**: rewritten with native Tauri file dialog (Browse button),
  dual open mode (external browser + in-app Tauri window), runtime dApp dir
  management, and network dApp discovery.
- **WebRTC endpoint unification**: renamed `/api/webrtc/signal` → `/api/media/signal`
  to group all WebRTC/media endpoints under `/api/media/*`.
- Removed the in-app `Chain`/`Blockchain` tabs from main App.tsx; chain UI is now
  the standalone `/dapp/chaindemo` dApp under `frontend/src/pages/chaindemo/`.
- Added `Blockchain` tab to the main app with media upload (images, videos, audio).
- Notes dApp: client-side encrypted notes at `/dapp/notes` using X25519+AES-GCM.

### Decoupling & Emoji Fix (Completed)
- Replaced symlinks (`prototypeC/frontend`, `prototypeC/node`) with real directory
  copies so Prototype C can evolve independently from Prototype B.
- Reverted `prototypeB/` to the `3f58d0d` (community-only) state — removed all
  blockchain/Notes experiments that had leaked into Prototype B via the symlinks.
- Fixed emoji rendering: copied `NotoColorEmoji-Regular.ttf` to
  `prototypeC/frontend/public/assets/fonts/` and wired it into `main.css` via
  `@font-face` with `font-display: swap`. Vite copies it to `dist/assets/fonts/`
  and the node serves it at `/assets/fonts/NotoColorEmoji-Regular.ttf`.
- Fixed `vite.config.ts` `base: './'` so asset paths resolve correctly in the
  Tauri WebView and self-hosted node context.
- Added `test_multi_identity.js` e2e test: 3 distinct identities, community creation,
  member promotion, and text/image/video/audio media visibility verification.
- Updated `scripts/setup.js` to copy directories instead of creating symlinks.

### Frontend/Node Ownership Note

The `prototypeC/frontend` and `prototypeC/node` directories were **decoupled**
from `prototypeB` — they are now real directory copies, not symlinks.

**Why:** Symlinks created a coupling risk where Prototype B changes (e.g. the
blockchain or Notes dApp experiments) leaked into Prototype C silently. The
copy approach lets each prototype evolve independently.

**Procedure used:**
1. Broke the symlinks (`rmdir prototypeC/frontend`, `rmdir prototypeC/node`).
2. Copied the current (feature-complete) `prototypeB/frontend` and
   `prototypeB/node` into `prototypeC/` as real directories.
3. Reverted `prototypeB/` to its pre-experiment state (`3f58d0d`) — restoring
   clean community-only code while Prototype C retains all experimental features
   (chain, notes, dApp router) as independent copies.
4. Updated `scripts/setup.js` `linkSources()` to use `fs.cpSync` (copy) instead
   of `fs.symlinkSync` (symlink) when directories don't yet exist.

To re-sync from a future Prototype B commit:
```bash
rm -rf prototypeC/frontend prototypeC/node
cp -r prototypeB/frontend prototypeC/frontend
cp -r prototypeB/node prototypeC/node
```

**Emoji font fix**: The NotoColorEmoji-Regular.ttf font was copied into
`prototypeC/frontend/public/assets/fonts/` and referenced via `@font-face` with
an absolute URL (`/assets/fonts/NotoColorEmoji-Regular.ttf`) in `main.css`.
This avoids bundling the 25 MB font into every Vite build chunk. Vite copies the
`public/` directory to `dist/` as-is, and the node serves it via the existing
`/assets` static-file route.

### Test Scripts

- **`prototypeC/scripts/chain_test.js`** — Continuous anchor round tester with
  support for all new chain features:
  - `--enable-chain`: runs multi-validator propose/sign/commit flow
  - `--validators`: comma-separated pubkey list for validator mode
  - `POST /api/chain/anchor-payload`: embeds small payloads (< 100 KB) directly
    in the anchor tx; oversize payloads are rejected with `413`
  - `GET /api/chain/block/latest`: verifies latest block is readable
  - `POST /api/chain/propose`, `POST /api/chain/sign`, `POST /api/chain/commit`:
    full consensus flow when running with `DDN_ENABLE_CHAIN=1` and `DDN_VALIDATORS`

- **`prototypeB/scripts/test_e2e.js`** — 2-node e2e test suite extended with:
  - **Phase 6.3 (Private Community Model)**: creates private community (`is_private: true`),
    retrieves OsRng group key via `POST /api/community/key/:cid`, adds member with
    `encrypted_group_key`, verifies both nodes can retrieve the key post-membership
  - **Phase 6.4 (dApp Registration & Discovery)**: registers a dApp record via
    `POST /api/dapp/register`, discovers via `GET /api/dapp/discover`, verifies
    gossip propagation to node2 after sync
  - **Phase 6.5 (Runtime dApp Directory)**: changes dApp dir via
    `POST /api/dapps/dir`, verifies local list reflects change

---

## C-4: Mobile Distribution (Future — Low Priority)

### Android Target

Tauri supports Android (v2.x). To add Android support:

```bash
# Install Android target
cargo install cargo-tauri
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-androideabi

# In tauri.conf.json, add to bundle:
# "targets": ["msi", "dmg", "nsis", "apk", "appbundle"]

# Build
cargo tauri build --target aarch64-linux-android
```

**Considerations**:
- The Rust node (libp2p, CAS) compiles to Android via Rust targets.
- The SolidJS frontend runs in Android System WebView.
- Media handling: use native Android file pickers for uploads.
- Tauri Android API exposes filesystem, notifications, etc. via JS API.

### Media Encoding (Future — Low Priority)

For video transcoding and image optimization in the web client or Tauri app:

**Options**:
1. **Client-side (Web)**: Use `canvas` + `MediaRecorder` API for video encoding.
   Limitations: no hardware acceleration, limited codec support.
2. **Client-side (Tauri)**: Use `tauri-plugin-ffmpeg` or call `ffmpeg` as a sidecar
   binary to transcode videos to multiple resolutions (H.264 + H.265).
3. **Node-side**: The ddn-node can optionally transcode media on ingest using
   `ffmpeg-next` Rust crate, but this increases resource usage.

**Recommended approach**:
- Images: client-side resize via Canvas API before upload (reduce to max 1080p).
- Videos: Tauri app can use ffmpeg sidecar to produce HLS segments for streaming.
  Web client falls back to direct upload (no transcoding) for simplicity.
- All media stored in CAS with proper mime type metadata.

---

## C-5: Web3.0 MetaMask Integration — Pre-Plan

### Goal

Enable a **standard Web3 website/DApp** (plain HTML + ethers.js/vite) to connect to
the Prototype C anchor chain via the **MetaMask browser extension** — using
`window.ethereum`, `eth_requestAccounts`, `eth_sendTransaction`, etc. — the same way
it connects to Ethereum or any EVM chain.

### The fundamental gap

MetaMask speaks the **Ethereum JSON-RPC API** (`eth_*`, `net_*`, `web3_*` methods).
The DDN node speaks a **custom REST API** and uses:

| Layer | DDN Today | MetaMask / Ethereum |
|---|---|---|
| Identity | Ed25519 pubkey | secp256k1 (ECDSA recovery) |
| Address format | hex pubkey CID | `0x` + 20-byte keccak address |
| Transaction signing | `ed25519-dalek` over record hash | secp256k1 `personal_sign` / EIP-155 |
| Execution model | Anchor-only (no VM) | EVM smart contracts |
| State | Rust structs + JSON | Merkle Patricia tries |
| RPC transport | HTTP REST + WebSocket events | JSON-RPC over HTTP/WS |

**Bottom line**: MetaMask cannot talk to DDN's chain as-is. One of three integration
paths must be chosen.

---

### Integration Path A — Full EVM Compatibility (recommended for learning)

Turn the DDN node itself into a **minimal EVM L1**: add an Ethereum-compatible
JSON-RPC server + EVM execution engine, and keep the DDN record system running
alongside it.

#### What it enables

- MetaMask "Connect" works out of the box
- `eth_sendTransaction` for gas-based ops
- Smart contracts (Solidity) that store DDN record CIDs or emit events
- A standalone web dApp (no Tauri) hosted on IPFS or any static host

#### Architecture

```
┌─────────────────────────────────────────────────────────┐
│  MetaMask extension (window.ethereum)                    │
│  requests accounts, signs txs, injects provider          │
├─────────────────────────────────────────────────────────┤
│  DDN Node (Rust)                                          │
│  ┌───────────────────┐  ┌─────────────────────────────┐  │
│  │  JSON-RPC layer    │  │  EVM engine (revm)          │  │
│  │  eth_*, net_*,     │←→│  StateDB: address↔DDN-key  │  │
│  │  web3_* methods    │  │  Gas: free or DDN-native    │  │
│  └────────┬───────────┘  └────────┬──────────────────┘  │
│           │ HTTP/WS (port 8545)   │                        │
│           │                       │                        │
│  ┌────────▼───────────┐  ┌────────▼──────────────────┐  │
│  │  Anchor chain       │  │  DDN records + CAS + gossipsub│  │
│  │  (existing)         │  │  (existing)                 │  │
│  └─────────────────────┘  └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

#### Implementation steps

**Step A1 — Identify/EVM mapping crate.**

Add an Ethereum-compatible address derivation so each DDN Ed25519 identity maps
to an EVM address deterministically:

```
DDN_pubkey (32 bytes) → keccak256 → last 20 bytes → 0x… EVM address
```

Rust crates: `sha3` (Keccak-256), `ethereum-types`, `alloy-primitives`.
Ed25519→EVM is a **one-way mapping**; for actual signing, the DDN secret seed
is used to derive an **secp256k1 keypair** via `libsecp256k1` or `k256`:
`secp256k1_secret = SHA-256(ed25519_seed)[0:32]`.

**Step A2 — EVM execution engine.**

Add `revm` (the pure-Rust Ethereum Virtual Machine) to `node/Cargo.toml`:

```toml
revm = { version = "9", features = ["with-evm"] }
reed-solomon = "1"          # optional: for error correction
alloy-primitives = "0.7"     # types: Address, U256, TxHash
alloy-serde = "0.7"          # JSON-RPC ser/deser
k256 = { version = "0.13", features = ["ecdsa"] }  # secp256k1 signing
```

**Step A3 — JSON-RPC server.**

Implement an HTTP + WebSocket JSON-RPC endpoint (port `8545`, configurable via
`DDN_RPC_PORT`). Must implement at minimum:

| Method | Purpose |
|---|---|
| `eth_chainId` | Return a chain ID (e.g. DDN's genesis height or a configured value) |
| `eth_accounts` | Return the node's EVM address(es) |
| `eth_requestAccounts` | Same (local node auto-approves since key is local) |
| `eth_getBalance` | Return native balance (DDN gas token) |
| `eth_getBlockByNumber` | Return block from the anchor chain, adapted to Eth format |
| `eth_getBlockTransactionCountByNumber` | Tx count in a block |
| `eth_getTransactionByHash` | Map an AnchorTx to Eth tx format |
| `eth_getTransactionReceipt` | Return receipt-like structure |
| `eth_call` | Execute a `eth_call`-style read (no signing) |
| `eth_sendRawTransaction` | Accept signed EIP-155 txs, verify secp256k1 recovery |
| `eth_sendTransaction` | Node signs with its secp256k1 key (local) |
| `eth_estimateGas` | Return fixed/estimated gas |
| `eth_getTransactionCount` | Nonce: use the identity's anchored record count or a counter |
| `net_version` | Chain ID |
| `net_peerCount` | Return libp2p connected peer count |
| `eth_subscribe` / `eth_unsubscribe` | Push block headers / logs via WebSocket |

**Step A4 — StateDB bridge.**

Implement `revm::db::Database` trait. The StateDB maps:
- EVM addresses ↔ DDN Ed25519 pubkey CIDs
- Balances (gas token) ← stored in `chain_state.json` or a new `evm_state.json`
- Nonces ← anchored transaction count per identity

```rust
// node/src/evm/state_db.rs
struct DdnDB {
    chain: Arc<chain::AnchorChain>,
    identities: Arc<RwLock<HashMap<Address, String>>>,  // EVM addr → DDN pubkey
    balances: Arc<RwLock<HashMap<Address, U256>>>,
}
impl Database for DdnDB { /* ... reads from AnchorChain blocks ... */ }
```

**Step A5 — Gas model.**

Choose one:

- **(a) Gasless / lazy gas**: All `eth_call` and `eth_sendRawTransaction` operations
  are free (gas = 0). The node auto-approves. Simplest, but not "real" Web3.
- **(b) Native gas token**: Mint a DDN gas token to each identity on first EVM use.
  Gas is burned for chain writes. More realistic but adds token economics.
- **(c) Gas sponsorship**: The node pays for everything (meta-tx pattern).

**Step A6 — Solidity contracts.**

Write contracts that bridge DDN records ↔ EVM:

```solidity
contract DDNAnchor {
    struct Anchor {
        string recordCid;   // DDN record CID (sha256 hex)
        uint256 height;
        uint256 timestamp;
        address author;     // EVM address mapped from DDN identity
    }

    mapping(uint256 => Anchor[]) public anchorsByHeight;
    mapping(string => Anchor) public anchorByCid;

    event Anchored(string indexed cid, uint256 height, address indexed author);

    function anchor(string calldata recordCid) external {
        // Only validator accounts can anchor (or anyone if gasless)
        anchorsByHeight[block.number].push(
            Anchor(recordCid, block.number, block.timestamp, msg.sender)
        );
        anchorByCid[recordCid] = anchorsByHeight[block.number].last;
        emit Anchored(recordCid, block.number, msg.sender);
    }

    function verify(string calldata cid, uint256 height) external view returns (bool) {
        Anchor memory a = anchorByCid[cid];
        return a.height == height && a.recordCid == cid;
    }
}
```

**Step A7 — Web DApp (separate from Tauri).**

Create `prototypeC/evm-dapp/` — a standalone Vite + ethers.js project:

```
evm-dapp/
├── index.html
├── package.json
├── src/
│   ├── App.tsx      # MetaMask connect btn, write anchor, read proofs
│   └── hooks/
│       └── useEvm.ts  # window.ethereum wrapper
└── contracts/
    └── DDNAnchor.sol
```

```typescript
import { ethers } from 'ethers';

// 1. Connect MetaMask
const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.send('eth_requestAccounts', []);
const address = await signer.getAddress();

// 2. Write a record CID to the chain
const contract = new ethers.Contract(DDN_ANCHOR_ADDR, abi, signer);
const tx = await contract.anchor(recordCid);
await tx.wait();

// 3. Verify later
const ok = await contract.verify(recordCid, blockNumber);
```

Add the dApp to `tauri.conf.json` as a second window or open in an external browser.

#### Effort estimate: ⭐⭐⭐⭐☆ (high)

- **Weeks 3–4** of focused Rust work (JSON-RPC + revm integration)
- **Week 2** of Solidity + frontend
- **Dependencies**: `revm`, `k256`, `alloy-primitives`, `sha3`, `jsonrpc` server crate
- **Risk**: revm API churn, secp256k1 ↔ Ed25519 key derivation correctness

---

### Integration Path B — Bridge Contract (on real Ethereum/Polygon)

Keep the anchor chain unchanged. Deploy a Solidity contract on a **real EVM chain**.
The DDN validator node periodically posts block headers/commitments to that contract.
MetaMask dApps read anchor data by calling the contract.

#### Architecture

```
┌────────────┐    posts block hash + merkle root    ┌────────────────────┐
│ DDN Node   │─────────────────────────────────────▶│  Eth Bridge Contract │
│ (anchor    │  every N blocks / on-demand          │  (Ethereum L1/L2)   │
│  chain)    │                                      │                     │
└────────────┘                                      └─────────▲──────────┘
                                                                  │
┌────────────────────────┐                                      │
│ MetaMask dApp          │◀─ reads anchors + proofs ────────────┘
│ (ethers.js + viem)    │
└────────────────────────┘
```

#### What it enables

- Full standard Web3 experience (real gas, real wallets, real explorer support)
- DDN records anchored into a real Ethereum block for timestamp/tamper evidence
- No changes to the DDN node's existing chain logic

#### Implementation steps

**Step B1 — Solidity contract**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract DDNAnchorRegistry {
    struct BlockHeader {
        uint256 height;
        bytes32 parentHash;
        bytes32 stateRoot;       // merkle root of AnchorTxs
        uint256 timestamp;
        bytes validators;        // ABI-encoded validator list
    }

    mapping(uint256 => BlockHeader) public blocks;
    mapping(bytes32 => bool) public anchoredCids;
    uint256 public latestHeight;

    event HeaderSubmitted(uint256 indexed height, bytes32 stateRoot, bytes32 blockHash);
    event CidAnchored(bytes32 indexed cid, uint256 height, address indexed author);

    /// @notice Submit a block header + CID commitments (called by a DDN validator node)
    function submitHeader(
        uint256 height,
        bytes32 parentHash,
        bytes32 stateRoot,
        uint256 timestamp
    ) external {
        blocks[height] = BlockHeader(height, parentHash, stateRoot, timestamp, "");
        latestHeight = height;
        emit HeaderSubmitted(height, stateRoot, blockhash(height));
    }

    /// @notice Submit a record CID for anchoring in the next block
    function anchorCid(bytes32 cid) external returns (bool) {
        anchoredCids[cid] = true;
        emit CidAnchored(cid, latestHeight, msg.sender);
        return true;
    }
}
```

**Step B2 — Bridge submitter (Rust)**

A new node module `node/src/bridge/` that:
- Periodically (every N blocks or every M seconds) calls `submitHeader` on the
  Ethereum contract using a validator's secp256k1 key (same derivation as Path A)
- Optionally batch-anchors CIDs via `anchorCid`
- Uses `ethers-rs` or `alloy` to sign + submit transactions

```rust
// node/src/bridge/ethereum.rs
pub struct EthBridge {
    wallet: LocalWallet,          // secp256k1, derived from DDN identity
    provider: Provider<Http>,
    contract: DDNAnchorRegistry,
    chain: Arc<AnchorChain>,
}
impl EthBridge {
    async fn submit_header(&self) -> Result<()> {
        let latest = self.chain.latest_block().await;
        self.contract.submitHeader(
            latest.header.height,
            latest.header.parent_hash,
            latest.header.merkle_root,
            latest.header.timestamp,
        ).send().await?;
    }
}
```

**Step B3 — Web DApp**

Uses `viem` or `ethers.js` to:
1. Connect MetaMask and select the bridge contract
2. Read anchored CIDs from events
3. Fetch full DDN record data from the node's REST API (`/api/record/:cid`)
4. Verify Merkle inclusion proof against the on-chain stateRoot

```typescript
import { createPublicClient, http, parseEther } from 'viem';
import { mainnet } from 'viem/chains';

const client = createPublicClient({ chain: mainnet, transport: http() });

// Read the latest anchored block
const registry = getContract({ address: BRIDGE_CONTRACT_ADDR, abi, client });
const height = await registry.latestHeight();
const header = await registry.blocks(height);

// Verify a record CID is anchored
const isAnchored = await registry.anchoredCids(recordCid);
```

**Step B4 — Local development variant (Anvil)**

For local testing without real ETH, use `anvil` (foundry):

```bash
anvil  # local EVM L1 with pre-funded accounts
# Node points bridge to http://127.0.0.1:8554
# MetaMask adds "Localhost 8554" network
```

#### Effort estimate: ⭐⭐⭐☆☆ (medium-high)

- **Week 2** Solidity contract + deployment to a testnet
- **Week 2** Rust bridge submitter (`alloy` or `ethers-rs`)
- **Week 1** Frontend (ethers.js/viëm)
- **Dependencies**: `alloy` or `ethers`, `foundry` (anvil for local)
- **Risk**: Testnet ETH cost for development (solved by Anvil/local)

---

### Integration Path C — MetaMask Snap (custom RPC provider)

Use a [MetaMask Snap](https://docs.metamask.io/snaps) to create a **custom JSON-RPC
provider** that proxies `eth_*` calls to the DDN node's existing REST API. No EVM,
no Solidity — the Snap translates Ethereum-style calls into DDN operations.

#### How it works

```
┌──────────────┐           ┌────────────────┐          ┌────────────┐
│ MetaMask     │  JSON-RPC │  MetaMask Snap  │  REST   │ DDN Node   │
│ (window.     │ ─────────▶│  (isolated     │ ───────▶│ (existing) │
│  ethereum)  │            │   JS sandbox)  │         │            │
└──────────────┘           └────────────────┘        └────────────┘
```

#### Limitations

- Snaps run in a **strict sandboxed JS environment** with no network access to
  `localhost` by default (must be granted).
- The Snap would translate `eth_sendRawTransaction` into `POST /api/chain/anchor`
  — but without an EVM, there's no concept of "gas", "nonce", or "smart contract call".
- MetaMask UI ("Connect", "Send", balance display) expects real Ethereum semantics
  (gas fees, nonce, balance). A Snap can't fully fake these.

#### Verdict: **Not recommended**

This path only works if you're OK with a degraded MetaMask experience (no real
balances, no explorer support, custom gas handling). It's more of a hack than a
solution.

---

### Identity & Key Mapping (all paths)

All three paths need a consistent way to derive an **Ethereum-compatible signing key**
from the DDN **Ed25519 identity**:

```
DDN Ed25519 seed (32 bytes)  ──SHA-256──▶  secp256k1 private key (32 bytes)
                                      └──▶  0x… EVM address (keccak256 last 20)
```

This is **deterministic**: one DDN identity ↔ one EVM address. Users can export
this derived key into MetaMask, or the node itself acts as the signer (Path A local
mode) for auto-signing without MetaMask.

```rust
// node/src/evm/keys.rs — new file
use k256::ecdsa::SigningKey;
use sha3::{Digest, Keccak256};

pub fn ddn_to_evm_address(ddn_pubkey_hex: &str) -> String {
    let bytes = hex::decode(ddn_pubkey_hex).unwrap();
    let mut hasher = Keccak256::new();
    hasher.update(&bytes);
    let full = hasher.finalize();
    format!("0x{}", hex::encode(&full[12..]))
}

pub fn seed_to_secp256k1(ddn_seed: &[u8; 32]) -> [u8; 32] {
    let mut h = sha2::Sha256::new();
    h.update(ddn_seed);
    let mut key = [0u8; 32];
    key.copy_from_slice(&h.finalize());
    key
}
```

---

### Recommended Path: **Path A (EVM Compatibility) + Anvil for local**

For a learning-first project where the goal is to understand Web3 + MetaMask
integration, **Path A** is the most pedagogically valuable:

1. You learn how an EVM node actually works (JSON-RPC, StateDB, gas).
2. The node becomes a real (if minimal) EVM chain.
3. MetaMask connects as a "Custom RPC" — no testnet ETH needed.
4. You can deploy Solidity contracts that anchor DDN record CIDs.
5. The existing anchor chain continues to run alongside (dual purpose).

#### Minimal Viable Prototype A (MVP) — steps to implement first:

1. Add `revm`, `k256`, `sha3`, `alloy-primitives`, `jsonrpc-core` to
   `node/Cargo.toml`.
2. Add `src/evm/mod.rs` with:
   - `ddn_to_evm_address()` and `seed_to_secp256k1()`
   - `EthStateDB` implementing `revm::db::Database`
   - `handle_jsonrpc(req: JsonRpcRequest) -> JsonRpcResponse` that maps `eth_*`
     methods to revm calls + AnchorChain queries
3. Add `/eth` HTTP route + `/eth` WebSocket route on `DDN_RPC_PORT` (default 8545).
4. Deploy a minimal `DDNAnchor.sol` via `cast` or `forge create`.
5. Build `evm-dapp/` with Vite + ethers.js: connect MetaMask, write + read anchors.

#### What stays the same (no changes needed):

- DDN peer gossipsub / CAS / identity / records — untouched
- Existing `POST /api/chain/anchor` REST API — untouched
- Anchor chain consensus (2/3 PoS) — untouched
- Tauri desktop shell — can optionally embed the EVM dApp as a tab

#### What the web DApp does differently:

Instead of `POST /api/record/sign` + `POST /api/record` + `POST /api/chain/anchor`
(the old REST flow), the EVM dApp does:

```typescript
import { ethers } from 'ethers';
const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner();

// Deploy or connect to DDNAnchor contract
const anchor = new ethers.Contract(ANCHOR_ADDR, abi, signer);

// Single transaction that: (a) signs, (b) anchors, (c) emits event
const tx = await anchor.anchorRecord(recordCid, { gasLimit: 100000 });
const receipt = await tx.wait();

// Verify on-chain
const ok = await anchor.verifyAnchor(recordCid, BigInt(receipt.blockNumber));
```

---

### Summary Table

| Path | EVM compatible? | Gasless dev? | Smart contracts? | Node changes | Difficulty |
|---|---|---|---|---|---|
| A — Full EVM | Yes | Yes (gas=0) | Yes | Major (revm + JSON-RPC) | ⭐⭐⭐⭐☆ |
| B — Bridge contract | N/A (on-eth) | No (need ETH) | Yes (Eth side) | Medium (bridge submitter) | ⭐⭐⭐☆☆ |
| C — MetaMask Snap | No (proxy) | Yes | No | Minimal (Snap only) | ⭐⭐ (but limited) |

**Next step**: Choose Path A (recommended), then implement steps A1–A7 in order.
Path B is the fallback if you want a production-grade bridge to real Ethereum
without adding an EVM engine to the node.

---

### End-to-End Workflow Diagram (Path A — EVM + MetaMask)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           META-MASK EXTENSION                                   │
│                                                                                 │
│  Browser: chrome://extensions → MetaMask is ON / unlocked                      │
│  Accounts: 0x1234...abcd  (user's real secp256k1 wallet)                       │
├─────────────────────────────────────────────────────────────────────────────────┤
│                           STEP 1: Connect Wallet                               │
│                                                                                 │
│  1. User opens web dApp (e.g. http://localhost:5173)                             │
│  2. DApp calls window.ethereum.request({ method: 'eth_requestAccounts' })       │
│  3. MetaMask shows: "localhost:8545 wants to connect"                           │
│     → User approves → returns [0x..., 0x...]                                    │
├─────────────────────────────────────────────────────────────────────────────────┤
│                           STEP 2: Write to chain                                 │
│                                                                                 │
│  4. User fills a form: "Record CID = bafz...xyz, Text = 'hello'"               │
│  5. DApp calls contract.anchor(cid) via ethers.js:                             │
│     → ethers constructs an eth_tx (to: contract_addr, data: anchor(cid))       │
│     → MetaMask pops up "Sign transaction?" with gas estimate (e.g. 50k gas)     │
│     → User clicks "Confirm" → MetaMask signs with secp256k1                    │
│     → Signed raw tx is sent to RPC endpoint                                     │
├─────────────────────────────────────────────────────────────────────────────────┤
│                     DDN NODE (running locally, port 8545)                        │
│                                                                                 │
│  6. JSON-RPC server receives eth_sendRawTransaction(signed_tx)                  │
│  7. Extracts tx, uses revm to execute:                                          │
│     → Recovers sender EVM address from secp256k1 signature                     │
│     → Looks up which DDN identity maps to that EVM address                     │
│     → Calls DDNAnchor.anchor(cid) in Solidity → emits CidAnchored event       │
│     → StateDB updates: anchoredCids[cid] = true                                │
│  8. Simultaneously, the node's native anchor chain ALSO records it:             │
│     → AnchorChain.anchor_txs.push(AnchorTx{record_cid: cid, ...})              │
│     → Next 10s tick → propose_block() → commit_block()                         │
│     → chain_state.json updated                                                 │
│  9. Response sent back: tx_hash, then receipt when mined                        │
├─────────────────────────────────────────────────────────────────────────────────┤
│                           STEP 3: Read back                                      │
│                                                                                 │
│  10. MetaMask/ethers: provider.waitForTransaction(txHash)                      │
│  11. Dapp calls contract.verify(cid) → returns true                            │
│  12. Dapp optionally calls DDN REST: GET /api/chain/record/bafz...             │
│      → Returns height, proof, committed=true                                   │
│  13. Dapp fetches full record: GET /api/record/bafz... → post text, media       │
└─────────────────────────────────────────────────────────────────────────────────┘


┌─────────────────────────────────────────────────────────────────────────────────┐
│                    BROWSER TAB: STANDALONE WEB DAPP                             │
│                    (NOT inside Tauri — pure browser)                            │
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────┐       │
│  │  http://localhost:5173 (or any HTTPS site)                          │       │
│  │                                                                     │       │
│  │  index.html                                                        │       │
│  │  ├── App.tsx  (connect button, anchor form, proof viewer)          │       │
│  │  ├── ethers.js / viem  (talks window.ethereum)                     │       │
│  │  └── abis/DDNAnchor.json                                          │       │
│  └──────────────────────────────────────┬──────────────────────────────┘       │
│                                         │                                        │
│  ┌──────────────────────────────────────┴──────────────────────────────┐       │
│  │  MetaMask Extension (user's wallet)                                 │       │
│  │  • Holds real secp2561 key derived from user's DDN seed            │       │
│  │  • Signs transactions, shows gas, manages accounts                │       │
│  └──────────────────────────────────────┬──────────────────────────────┘       │
│                                         │ JSON-RPC (eth_sendRawTransaction)    │
│  ┌──────────────────────────────────────┴──────────────────────────────┐       │
│  │  DDN Node (Tauri sidecar or standalone)                          │       │
│  │  port 8545: JSON-RPC server (revm + AnchorChain bridge)           │       │
│  │  port 3000: REST API (records, CAS, gossipsub, identity)         │       │
│  │  port 9000: WebSocket events (/ws/events)                        │       │
│  └──────────────────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────────────────┘


┌─────────────────────────────────────────────────────────────────────────────────┐
│                    TAURI DESKTOP APP (embedded mode)                           │
│                    (alternative: everything in one window)                       │
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────┐       │
│  │  Tauri Window                                                        │       │
│  │  ┌────────────────────────────────────────────────────────────┐      │       │
│  │  │  Tab: Wall     Tab: Chain     Tab: EVM dApp     Tab: Settings│      │       │
│  │  └─────────────────────────────────┬────────────────────────────┘      │       │
│  │                                    │                                │       │
│  │  WebView2 / WebKit                 │                                │       │
│  │  (SolidJS frontend)               │                                │       │
│  │  • calls /api/* REST              │                                │       │
│  │  • can also load evm-dapp/index.html as a tab│                        │       │
│  │  • can call /eth or /ws/events    │                                │       │
│  └────────────────────────────────────┴────────────────────────────────┘       │
│                                         │                                        │
│  ┌──────────────────────────────────────┴──────────────────────────────┐       │
│  │  DDN Node Sidecar (Rust)                                            │       │
│  │  • anchor chain (DDN_ENABLE_CHAIN=1)                               │       │
│  │  • EVM engine (revm on DDN_RPC_PORT=8545)                          │       │
│  │  • libp2p gossipsub + CAS + identity                               │       │
│  └──────────────────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### End-user setup flow

```
Phase 0 — Development (first time)
  ├─ Install: cargo install foundry-node (for anvil/cast/forge)
  ├─ Start node: DDNA_RPC_PORT=8545 DDNA_CHAIN_ID=4207 cargo run
  ├─ Start anvil:   anvil --port 8555 (optional; node 8545 is itself an EVM)
  └─ Dapp:          cd evm-dapp && npm install && npm run dev

Phase 1 — Connect MetaMask
  ├─ Browser → MetaMask → Settings → Networks → Add Network
  ├─   Network name: DDN Local
  ├─   RPC URL: http://127.0.0.1:8545
  ├─   Chain ID: 4207  (or whatever DDN_RPC_CHAIN_ID is set to)
  ├─   Currency: DDN
  ├─   Block Explorer URL: (leave blank)
  ├─ Open dApp URL (http://localhost:5173)
  ├─ Click "Connect Wallet" → approve in MetaMask
  └─ Done: the dApp now shows your EVM address 0x... and balance 0 DDN

Phase 2 — Deploy the anchor contract (once)
  ├─ forge create --rpc-url http://127.0.0.1:8545 \
  │                  --private-key <derived_secp256k1_from_identity> \
  │                  src/DDNAnchor.sol:DDNAnchor
  ├─ Copy the deployed contract address into evm-dapp/.env
  └─ The contract address is also stored in the node's evm_state.json

Phase 3 — Use the dApp
  ├─ Write: fill form, click "Anchor Record"
  │   → MetaMask signs tx (gas = 0 if gasless mode)
  │   → Node executes via revm, calls Solidity, emits event
  │   → Also adds to DDN anchor chain (REST /api/chain/anchor)
  │   → Confirmation appears in dApp
  ├─ Verify: click "Check inclusion"
  │   → Dapp calls contract.verify(cid, blockNum) → true/false
  └─ Read records: GET /api/record/:cid → fetch full payload from CAS
```

### Key insight: you don't deploy your own smart contract wallet

MetaMask connects with the user's **existing wallet** (the one they use for
Ethereum mainnet, testnets, etc.). The DDN node's EVM engine maps the EVM address
back to a DDN Ed25519 identity internally. The user doesn't need to think about
this mapping — MetaMask just works as it does on any other chain.
