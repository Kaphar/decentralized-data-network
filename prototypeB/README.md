# Prototype B — Rust Node + SolidJS Frontend

Phase 0 of the Decentralized Data Network: a standalone, local-first decentralized social prototype.

## Prerequisites

- **Rust** (stable, latest) — for the node backend
- **Node.js 20+** — for the frontend dev server

## Quick Start

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

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/identity` | Get this node's public key (user identity) |
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
