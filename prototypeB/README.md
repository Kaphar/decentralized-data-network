# Prototype B — Rust Node + SolidJS Frontend

Phase 0 of the Decentralized Data Network: a standalone, local-first decentralized social prototype.

## Prerequisites

- **Rust** (stable, latest) — for the node backend
- **Node.js 20+** — for the frontend dev server

## Quick Start

node scripts/test_e2e.js
node scripts/test_e2e.js --keep-running

```bash
# Build and run the Rust node (serves API + static frontend)
cd prototypeB/node
cargo run --release
# → listens on http://localhost:3000

# In a second terminal, build and serve the frontend separately (optional dev mode)
cd prototypeB/frontend
npm install
npm run dev
# → dev server at http://localhost:5173
```

The node serves the frontend automatically from `DDN_FRONTEND_PATH` (defaults to `./frontend`). For development, run `npm run dev` in the frontend directory to use Vite's hot-reloader.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DDN_DATA_DIR` | `./data` | Where blobs and records are stored on disk |
| `DDN_FRONTEND_PATH` | `./frontend` | Path to the built frontend directory |
| `DDN_HTTP_PORT` | `3000` | HTTP server listen port |
| `DDN_P2P_PORT` | `4001` | libp2p P2P listen port |
| `DDN_BOOTSTRAP_PEERS` | (empty) | Comma-separated list of bootstrap multiaddrs |

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/identity` | Get this node's public key, lock status, and auto_unlock flag |
| `POST` | `/api/identity/backup` | Export encrypted identity backup (body: `{password}`) |
| `POST` | `/api/identity/export` | Alias for `/api/identity/backup` |
| `POST` | `/api/identity/unlock` | Unlock identity with password (body: `{password}`) |
| `POST` | `/api/identity/import` | Import an identity file (body: `{file, password}`) — requires restart |
| `DELETE` | `/api/identity` | Delete identity file — fresh identity on next restart |
| `POST` | `/api/blob` | Upload a binary blob (media, files) |
| `GET` | `/api/blob/:cid` | Download a blob by its content ID |
| `GET` | `/api/blob` | List all stored blob CIDs |
| `POST` | `/api/record` | Submit a signed JSON record |
| `POST` | `/api/record/sign` | Sign a record (request body: `{type, author, prev, ts, payload}`) |
| `GET` | `/api/record/:id` | Fetch a single record by ID |
| `GET` | `/api/records` | List all known records |
| `GET` | `/api/wall` | Get all posts (type=post records) |
| `GET` | `/api/dm?me=<pubkey>&other=<pubkey>` | Filter DM messages between two identities |
| `POST` | `/api/dm/seal` | Encrypt a DM with X25519+AES-GCM (`{author, to, plaintext}` → `{ciphertext, nonce, ephemeral_pubkey}`) |
| `POST` | `/api/dm/open` | Decrypt a DM (`{ciphertext, nonce, ephemeral_pubkey, sender}` → `{plaintext}`) |
| `POST` | `/api/media/offer` | Create a `media_offer` record for WebRTC file transfer |
| `POST` | `/api/media/accept` | Create a `media_accept` record in response to a media offer |
| `POST` | `/api/media/keypair` | Generate an ephemeral X25519 keypair for WebRTC signaling |
| `POST` | `/api/report` | Publish a `report` record flagging content (`{target_cid, reason}`) |
| `GET` | `/api/moderation` | Get blocked/hidden CIDs and trusted moderator pubkeys |
| `POST` | `/api/peers` | Add a peer node (`{url: "http://host:port"}`) |
| `GET` | `/api/peers` | List known peers |
| `POST` | `/api/sync` | Pull records from all known peers |

## Testing the Node

```bash
# Check Rust compilation
cd prototypeB/node && cargo check

# Generate a test key pair
cd prototypeB/scripts && bash gen_keys.sh ../data/dev_keys.json
# (Windows: powershell -File gen_keys.ps1 -Output ../data/dev_keys.json)
```

## End-to-End Test (slows 2 nodes)

The e2e test script launches **two** Rust nodes on separate ports with isolated data
directories, then exercises the core API surface: identity, peer sync, posting,
E2EE DMs, blob upload, moderation, and identity management.

```bash
# From the prototypeB directory:
# Bash (Linux/macOS):
cd prototypeB
bash scripts/test_e2e.sh

# PowerShell (Windows):
cd prototypeB
pwsh -File scripts/test_e2e.ps1

# Slow mode — adds 3-second delays between test steps so you can watch
# the nodes gossip and sync in real time (useful for debugging):
bash scripts/test_e2e.sh --slow
# or
pwsh -File scripts/test_e2e.ps1 -Slow
```

Both nodes are started with `cargo run --release` using the following configuration:

| Node | HTTP Port | P2P Port | Data Dir |
|------|-----------|----------|----------|
| 1    | 3001      | 4001     | `%TEMP%/ddn-test-data1` |
| 2    | 3002      | 4002     | `%TEMP%/ddn-test-data2` |

Test phases covered:
- **Identity** — distinct pubkeys, auto-unlock status
- **Peer sync** — connect node2 to node1, sync records
- **Posting** — sign + submit a post, verify it appears on the wall and gossips to the peer
- **E2EE DMs** — seal/open a direct message between the two nodes
- **Blobs** — upload and fetch a blob by CID
- **Moderation** — report content, query moderation list
- **Identity management** — export backup, unlock failure on wrong password, delete identity

Placeholders are included for future phases (reactions, community model, Tauri desktop).

## Frontend Development

```bash
cd prototypeB/frontend
npm install        # one-time setup
npm run dev        # start Vite dev server
npm run build      # production build
npm run typecheck  # type-check without emitting
```

## Architecture

See `PLAN.md` at the repository root for full architecture documentation.



