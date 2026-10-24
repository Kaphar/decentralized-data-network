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
cd ../.. && cargo run
```

### Build / Run (production bundle)

```bash
cargo tauri build
```

---

## C-2: Blockchain Anchor Chain (minimal, learn-first)

### Motivation

This is the user's first blockchain project. Rather than integrating a complex
existing chain (LBRY, Ethereum, etc.), we build a **minimal Proof-of-Stake-style
anchor chain** from scratch in Rust. The chain does **not** replace gossipsub — it
provides a tamper-evident, time-ordered log that DDN record CIDs can be anchored
into, so external observers can verify a record existed at a given block height.

### Design

#### Record (block) layout

Each block contains:
- `height: u64`
- `parent_hash: String` (SHA-256 of the previous block header)
- `timestamp: u64`
- `proposer: String` (pubkey of the validator that proposed it)
- `txs: Vec<AnchorTx>` — batch of anchor transactions

```rust
struct AnchorTx {
    author: String,      // Ed25519 pubkey of the DDN record author
    record_cid: String,  // The DDN record id (sha256 cid)
    ts: u64,             // When anchored (unix seconds)
    sig: String,         // Ed25519 signature by `author` over (record_cid || ts)
}

struct Block {
    height: u64,
    parent_hash: String,
    timestamp: u64,
    proposer: String,
    merkle_root: String, // root of anchor txs
    txs: Vec<AnchorTx>,
    nonce: u64,          // PoS "stake lottery" nonce
    hash: String,        // self (sha256 of the rest)
}
```

#### Consensus (simplified)

- A fixed set of **validator** pubkeys (configured at genesis — for the prototype,
  the node's own identity is the genesis validator).
- At each block, the next proposer is chosen deterministically from the validator
  set (round-robin for the prototype; a verifiable random function can replace this
  later).
- The proposer bundles pending `AnchorTx`s, builds a Merkle root, and signs the
  block header.
- Other validators sign a "vote" for the block (simple 2/3 supermajority). If
  signed, it's appended; otherwise the next proposer tries.

#### API (integrated into the node)

The anchor chain runs alongside the prototypeB node as a new Rust module
`node/src/chain/`:

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/chain/anchor` | Submit a signed `AnchorTx` (anchor a record CID). Body: `{author, record_cid, ts, sig}` |
| `GET` | `/api/chain/block/:height` | Fetch a block by height |
| `GET` | `/api/chain/block/latest` | Fetch the latest block |
| `GET` | `/api/chain/record/:cid` | Check if a record CID has been anchored (returns block height or null) |
| `GET` | `/api/chain/validators` | List current validator pubkeys |

#### Integration with DDN

- A new CLI flag `--enable-chain` (or `DDN_ENABLE_CHAIN=1`) opts the node into
  running the anchor chain.
- Optionally, the node auto-anchors new records it gossips (configurable per-record
  type, off by default to avoid spam/bloat).
- A frontend "Chain" tab shows the latest block, anchor history, and lets users
  anchor a selected post.

---

## C-3: Multi-DApp Architecture

### Goal

Let the same local node + desktop shell host multiple decentralized apps. The Wall
is the first; we add a **Guestbook** and **Notes** dapp as demos.

### Routing

The SolidJS shell in `App.tsx` adds a dApp router:

```
/#           → Wall  (default, existing)
/dapp/guestbook → Guestbook dapp
/dapp/notes     → Notes dapp
/settings       → (existing settings tab)
```

Routes are read from `window.location.hash` (hash-based, no server routing) and
mapped to a dApp module.

### Record namespace

DApp records optionally carry a `dapp` field in the payload (e.g.
`{ "dapp": "guestbook", "text": "hello" }`). The frontend filters known records by
this field. Existing record types are reused — no new on-chain schema needed.

### DApp: Guestbook

- A public, append-only wall scoped to `dapp: "guestbook"`.
- Posting creates a signed `post` record with `payload.dapp = "guestbook"`.
- Anyone can post; anyone can read.
- Reuses `PostList` + `PostForm` components with a `dapp` filter prop.

### DApp: Notes

- A private, per-user dapp. Notes are **encrypted client-side** (X25519 + AES-GCM,
  reusing the prototypeB DM crypto) before being stored/anchored.
- Each note is a `post`-type record with `payload.dapp = "notes"` and the note text
  stored as ciphertext in the payload.
- The Notes UI decrypts notes locally using the user's identity — the node only
  ever sees ciphertext.
- Optionally anchor note CIDs to the chain for tamper evidence (C-2).

### Shared infrastructure

- All dApps reuse the existing API client (`prototypeB/frontend/src/api/index.ts`).
- The node API is unchanged — dApps are a frontend routing/filtering concern.
- A `dapp` field in the payload provides optional filtering without schema churn.

---

## Implementation Order

1. **C-1 Tauri shell**: scaffold `Cargo.toml`, `tauri.conf.json`, `src/main.rs`
   with system tray + sidecar spawn. Wire settings persistence.
2. **C-1 Frontend integration**: build the prototypeB frontend, bundle into Tauri.
   Ensure the embedded frontend detects localhost-only mode (no node-URL selector).
3. **C-1 Packaging**: `cargo tauri build`, verify sidecar starts, tray updates.
4. **C-2 Chain module**: add `node/src/chain/` (Block, AnchorTx, validator set),
   integrate into `main.rs` with the 5 endpoints above.
5. **C-2 Frontend Chain tab**: display latest block, submit anchors.
6. **C-3 DApp router**: add routing to `App.tsx`, add `dapp` filter to `PostList`.
7. **C-3 Guestbook dApp**: minimal guestbook using existing post records.
8. **C-3 Notes dApp**: E2EE notes using prototypeB DM crypto + optional chain anchor.
