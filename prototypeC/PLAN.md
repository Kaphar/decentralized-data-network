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
  *full payload* for small records (short text posts / community posts / messages),
  and **CID-only** for records whose payload contains media (images, video, audio).
  The threshold is reuse of the existing `MEDIA_CAS_THRESHOLD` used by `PostForm.tsx`
  — any record whose `payload.media` is non-empty (i.e. references CAS blobs)
  anchors by CID only; otherwise the full `{type, author, payload, ts, sig}` is
  embedded in the AnchorTx so the block is self-contained for non-media content.
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
   identity, i.e. their Ed25519 pubkey) can decrypt. Symmetric-key sharing was
   considered but rejected for now because pubkey-targeting is already implemented
   and avoids out-of-band key exchange.
3. **Community-scoped records** — the encryption key is **derived from the
   community**, so anyone who is a member of that community can decrypt. The
   AnchorTx carries a `community_cid` reference; the actual key derivation path is
   left as a future step (see "Deferred").

### Block / AnchorTx layout (revised)

```rust
// A chain tx. For public records the payload is embedded directly;
// for encrypted records the payload is replaced by an encrypted envelope.
// For media-heavy records only the record_cid is stored (payload is nil).
struct AnchorTx {
    author: String,        // Ed25519 pubkey (the DDN author / record signer)
    record_cid: String,    // sha256 cid of the DDN record (always present, the notary anchor)
    ts: u64,               // unix seconds
    sig: String,           // Ed25519 sig by `author` over (record_cid || ts)
    // --- new fields (one of these groups is populated) ---
    payload: Option<serde_json::Value>,   // FULL payload for small/public records
    media_cid_only: bool,                 // true => only record_cid references the record (media case)
    // encrypted envelope (only when record is private):
    encrypted: Option<EncryptedEnvelope>,
    community_cid: Option<String>,        // for community-scoped records
    to: Option<String>,                   // recipient pubkey for u2u private messages
}

struct EncryptedEnvelope {
    ciphertext: String,
    nonce: String,           // hex AES-GCM nonce
    ephemeral_pubkey: String, // X25519 ephemeral, for u2u case
}

// Block unchanged, except header now also points at the tx set version:
struct Block {
    header: BlockHeader,     // height, parent_hash, timestamp, proposer, merkle_root, nonce, hash
    txs: Vec<AnchorTx>,
}
```

Notes:
- `record_cid` is **always** stored — this is the notary proof and the index key.
- The embedded `payload` / `encrypted` envelope is optional convenience for
  self-contained verification (a verifier can check the AnchorTx `sig` without
  fetching the CAS record, as long as the payload is inline).
- `media_cid_only` is a hint that the payload lives in CAS (the verifier must fetch
  the CID to see it); it is equivalent to "payload is nil."

### Consensus (implemented plan)

- A configurable **validator set**. Genesis = the node's own identity. The set is
  read from `DDN_VALIDATORS` (comma-separated pubkeys) if set, otherwise it is
  just the genesis validator. (Decision: keep round-robin proposer; make the set
  configurable so a second peer can be bootstrapped later.)
- **2/3 supermajority voting is implemented now**, even though the prototype runs
  with a single validator. A block is produced, then the proposer broadcasts a
  `Vote` record (signed). The block is committed to the log only after ≥2/3 of
  the validator set has signed it. With one validator, 2/3 of 1 = 1, so the
  genesis validator votes for its own blocks — functionally equivalent to
  self-propose today, but the vote path is real and ready for multi-validator.
- **Finality on this node** = a committed block in `chain_state.json`. Cross-node
  finality (syncing blocks across peers) is **not** implemented in this phase;
  treat a block as final-by-your-node once committed. (See "Deferred".)

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
| `POST` | `/api/chain/anchor` | Submit an AnchorTx. Body extends the old shape: `{author, record_cid, ts, sig, payload?, media_cid_only?, encrypted?, community_cid?, to?}`. `payload` is required for public small records; one of `payload`/`encrypted`/`media_cid_only` describes the content mode. Returns `202` + `"anchoring"` immediately (queued), `201` when committed to a block. |
| `GET` | `/api/chain/block/:height` | Fetch a block by height. |
| `GET` | `/api/chain/block/latest` | Fetch the latest **committed** block. |
| `GET` | `/api/chain/record/:cid` | Index lookup: returns `{cid, height, committed: bool}` (height = null if not anchored / still pending). |
| `GET` | `/api/chain/validators` | List current validator pubkeys. |
| `GET` | `/api/chain/votes/:height` | **New.** Return the set of validator signatures committed for a block (proof of 2/3 quorum). |
| `GET` | `/api/chain/index?dapp=x&community_cid=y` | **New.** Light node-side index over committed AnchorTxs for discoverability (does **not** bypass scanning — it is an optimization so clients don't have to walk every block). |
| `GET` | `/api/chain/proof/:cid` | **New.** Return a Merkle proof path for a record_cid against a recent block, so a third party can verify inclusion without trusting the node. |
| `POST` | `/api/chain/verify` | **New.** Submit `{payload, sig, record_cid, ts}` (or an encrypted envelope) and get back whether the AnchorTx `sig` verifies for `author` — usable before anchoring. |

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

- Cross-node block syncing / `DDN_BOOTSTRAP_PEERS` for the chain (only the single
  node's `chain_state.json` is authoritative today).
- Community key derivation for encrypted community records (schema reserved, KDF TBD).
- Symmetric-key-shared mode for encrypted records (rejected now in favor of pubkey
  and community-key modes; revisit if a real out-of-band use case emerges).
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

Operators/users can also install dApps at runtime without a node rebuild by
setting `DDN_DAPPS_DIR=<path>`. The `serve_dapp` handler resolves dApps from:

1. `DDN_DAPPS_DIR/<name>/index.html` (if the env var is set — takes priority), or
2. `<frontend_path>/dapps/<name>/index.html` (the built `dist/dapps/...`).

So an admin can `cp -r mydapp "$DDN_DAPPS_DIR/mydapp"` and immediately serve it at
`/dapp/mydapp`. The node restart is the only requirement.

The node serves the dApp HTML pages directly (no client-side routing needed for
dApps served from the network). The main app uses hash-based routing for its own
navigation (see `App.tsx` `setActiveTab`).

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
4. **C-2 Chain module**: add `node/src/chain/` (Block, AnchorTx with embedded payload / encrypted envelope / media_cid_only, validator set, vote/commit with 2/3 quorum), integrate into `main.rs` with the endpoints below.
   - `POST /api/chain/anchor`, `GET /api/chain/block/:height`, `GET /api/chain/block/latest`,
     `GET /api/chain/record/:cid`, `GET /api/chain/validators`,
     `GET /api/chain/votes/:height`, `GET /api/chain/index?...`, `GET /api/chain/proof/:cid`,
     `POST /api/chain/verify`.
   - `DDN_ENABLE_CHAIN=1` opts in; `DDN_VALIDATORS` configures the validator set.
5. **C-2 Frontend (as dApp)**: `src/pages/chaindemo/` (`ChainDemo.tsx` + `main.tsx` + `index.html`) — the standalone blockchain database view (full history, Merkle proofs, light queries). Served by the node at `/dapp/chaindemo` via the generic dApp router. Built by `npm run build:dapps`.
6. **C-3 DApp router**: generic `GET /dapp/:name` route serving `<dapps_dir>/<name>/index.html` (308 redirect to `/dapps/<name>/index.html`), with `DDN_DAPPS_DIR` for runtime dApp installs.
7. **C-3 Guestbook dApp**: standalone HTML page served by the node, filters by
   `dapp` field in records.

---

## Progress Log

### C-1: Tauri v2 Migration (Complete)
- `tauri.conf.json`: migrated from Tauri v1 to v2 format (`externalBin`, flattened config).
- `build.rs`: `tauri_build::build()` passing.
- `src/main.rs`: Tauri v1→v2 API migration (MenuItem, TrayIconBuilder, WebView, State).
- Icons: created multi-resolution `icon.ico`, `32x32.png`, `128x128.png`, `128x128@2x.png`.
- Sidecar binary: built `ddn-node.exe`, copied to `prototypeC/` as `ddn-node-x86_64-pc-windows-msvc.exe`.
- Symlinks: `prototypeC/node` → `prototypeB/node`, `prototypeC/frontend` → `prototypeB/frontend`.
- Full app runs: Tauri window opens, sidecar starts, frontend serves on `http://127.0.0.1:3000/`.

### C-2: Blockchain Anchor Chain (integrated into node)
- Added the chain module `node/src/chain/` with the hybrid AnchorTx (inline payload
  for small public records, `media_cid_only` for media, `encrypted` envelope for
  private records), round-robin proposer, and **2/3 vote/commit** (single-validator
  today, multi-validator ready).
- Endpoints: `POST /api/chain/anchor`, `GET /api/chain/block/:height`,
  `GET /api/chain/block/latest`, `GET /api/chain/record/:cid`,
  `GET /api/chain/validators`, `GET /api/chain/votes/:height`,
  `GET /api/chain/index?dapp=..&community_cid=..&author=..&encrypted=..`,
  `GET /api/chain/proof/:cid`, `POST /api/chain/verify`.
- `DDN_ENABLE_CHAIN=1` opts in; `DDN_VALIDATORS` configures the validator set.
- Finality is **time-driven (10 s producer tick) + ≥1 pending AnchorTx**, gated by
  the 2/3 commit. Blocks are persisted to `chain_state.json`.
- `Chain` tab (`ChainTab.tsx`) shows latest block, validators, fetch-by-height, and
  per-record anchor status (auto-checked + re-checked every 10 s).
- `Blockchain` tab (`ChainDemo.tsx`) is the standalone chain-as-database view:
  full history, Merkle proofs, light index queries.

### C-3: Multi-DApp Architecture (In Progress)
- Added `Blockchain` tab to the main app (chain is a core network feature, not a dApp).
- Added `/dapp/guestbook` route served by the node (standalone HTML page).
- Guestbook filters records by `payload.dapp === "guestbook"`.
- Guestbook is NOT embedded in the main app's tab bar — it's a network-distributed
  dApp accessible via browser or external WebView (see Architecture Decision above).
- Removed the in-app `Chain` and `Blockchain` tabs from the main SPA; the chain UI
  is now the standalone `/dapp/chaindemo` dApp under `frontend/src/pages/chaindemo/`,
  built by `npm run build:dapps` → `dist/dapps/chaindemo/`.
- Added generic `/dapp/:name` route (308 → `/dapps/<name>/index.html`) + `DDN_DAPPS_DIR`
  for runtime dApp distribution without a node rebuild or frontend rebuild.
- Chain tab: added media upload (images, videos, audio) with preview. Users can anchor
  messages with optional media to the blockchain.
- **Open question**: Should dApps be embedded as WebViews inside Tauri or accessed via browser?

### Note: Frontend/Backend Symlink Coupling

The `prototypeC/frontend` and `prototypeC/node` directories are symlinks to
`prototypeB/frontend` and `prototypeB/node` respectively (see `scripts/setup.js`).
This means any change to `prototypeB` — whether the Rust node (backend) or the
SolidJS frontend — is automatically picked up by `prototypeC`.

**Risk**: If `prototypeB` is updated and only the backend or frontend is changed
(say, a new `/api/chain/*` endpoint or a changed payload format), the symlinked
frontend will not match the backend, leading to runtime errors in the Tauri shell.

**Recommendation**: As the codebase grows, replace the symlinks with a one-time
copy of the frontend so `prototypeC` can be stabilized independently:

```bash
rm prototypeC/frontend
cp -r prototypeB/frontend prototypeC/frontend
```

If the symlink approach is kept, ensure that backend and frontend changes in
`prototypeB` are always applied in the same atomic commit so they stay in sync.

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
