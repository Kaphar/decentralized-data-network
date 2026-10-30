# Prototype C — Desktop Distribution + Blockchain + Multi-DApp

Builds on Prototype B (`prototypeB/`) — reuses the Rust `ddn-node` and the SolidJS
frontend. Prototype C adds: a Tauri desktop shell with system tray, a minimal
blockchain anchor chain, and a multi-dApp router.

See `PLAN.md` at the repository root and `prototypeC/PLAN.md` for the full design.

## Architecture: Main App vs Network-Distributed dApps

The **main Tauri WebView window** shows the home app: the Wall (network feed), File
transfer, the **Blockchain** tab (anchor chain explorer), and Settings. This is the
core network UI.

**dApps** like the Guestbook are **network-distributed**: served directly by the node
at a URL path (e.g. `http://127.0.0.1:3000/dapp/guestbook`). dApps are **not** embedded
in the main app's tab bar. They can be accessed through an external browser.

> **Open question**: Should dApps be embedded as additional WebViews inside the Tauri
> shell (e.g. as tabs alongside the Blockchain tab), or remain accessible only via
> browser? This is undecided — see `PLAN.md` §C-3.

## Components

| Component | Description |
| :--- | :--- |
| **Tauri shell** (`src/main.rs`, `tauri.conf.json`) | Desktop window + system tray. Spawns `ddn-node` as a sidecar. |
| **Sidecar node** (`node/`) | Rust node binary. Runs libp2p swarm, CAS, HTTP API, anchor chain, and serves dApp pages at `/dapp/*`. |
| **Embedded frontend** (`frontend/`) | SolidJS app with Wall, Files, Blockchain, and Settings tabs. Targets `127.0.0.1`. |

## Prerequisites

- Rust (stable) with the `tauri` toolchain: `cargo install cargo-tauri`
- Node.js 20+
- For Windows: WebView2 runtime (shipped with Windows 10/11)

## Development

```bash
# Build the sidecar node (one time, or when node code changes)
cd prototypeC/node
cargo build --release

# Build the SolidJS frontend (one time, or when frontend code changes)
cd ../frontend
npm install
npm run build

# Run the Tauri shell in development
cd ..
cargo tauri dev
```

The dev shell proxies `/api` to the sidecar on `http://127.0.0.1:3000`.

## Production Bundle

```bash
cargo tauri build
```

Output (installer + binary) lands in `src-tauri/target/release/bundle/`.

## Quick Test

```bash
node prototypeC/scripts/run_chain_test.js
```

This starts your node, fetches its pubkey, restarts with chain enabled, and runs the full test suite.

## Running the Sidecar Manually (All Modes)

The sidecar node supports environment variables for configuring chain, validators, and dApp settings:

### Basic HTTP Node

```bash
DDN_HTTP_PORT=3000 DDN_P2P_PORT=4001 DDN_DATA_DIR=./data ./ddn-node
```

### With Blockchain Anchor Chain Enabled

```bash
DDN_HTTP_PORT=3000 DDN_P2P_PORT=4001 DDN_DATA_DIR=./data DDN_ENABLE_CHAIN=1 ./ddn-node
```

Available chain endpoints:
- `GET /api/chain/block/latest` — latest block header
- `POST /api/chain/anchor` — anchor a record CID
- `POST /api/chain/anchor-payload` — anchor inline payload data (max 100 KB)
- `GET /api/chain/proposals` — pending block proposals (validator mode)
- `POST /api/chain/propose` — propose a new block (validator)
- `POST /api/chain/sign` — sign a proposed block (validator)
- `POST /api/chain/commit` — submit a signed block (validator)

### Multi-Validator Consensus

```bash
DDN_HTTP_PORT=3000 DDN_P2P_PORT=4001 DDN_DATA_DIR=./data DDN_ENABLE_CHAIN=1 DDN_VALIDATORS="<pubkey1>,<pubkey2>,<pubkey3>" ./ddn-node
```

A block is committed when `2/3 + 1` of the listed validators sign it.

### dApp Management

```bash
# Install a dApp from a local directory
curl -X POST http://127.0.0.1:3000/api/dapps/install -H 'Content-Type: application/json' \
  -d '{"source": "/path/to/dapp/dir", "name": "guestbook"}'

# Register a dApp record for gossip (network discovery)
curl -X POST http://127.0.0.1:3000/api/dapp/register -H 'Content-Type: application/json' \
  -d '{"cid": "dapp-cid-123", "name": "Guestbook", "path": "/dapp/guestbook"}'

# Discover registered dApps
curl http://127.0.0.1:3000/api/dapp/discover

# Change the dApp serving directory at runtime
curl -X POST http://127.0.0.1:3000/api/dapps/dir -H 'Content-Type: application/json' \
  -d '{"dir": "/custom/dapps/path"}'
```

### Private Communities

```bash
# Private communities require identity unlock
curl -X POST http://127.0.0.1:3000/api/identity/unlock -H 'Content-Type: application/json' \
  -d '{"password": "your-password"}'

# Create a private community (generates OsRng group key)
curl -X POST http://127.0.0.1:3000/api/community -H 'Content-Type: application/json' \
  -d '{"name": "Secret Group", "description": "Private members only", "is_private": true}'

# Retrieve the community group key (members only)
curl -X POST http://127.0.0.1:3000/api/community/key/<community_cid>

# Add a member with encrypted group key
curl -X POST http://127.0.0.1:3000/api/community/membership -H 'Content-Type: application/json' \
  -d '{"community_cid": "<cid>", "target_pubkey": "<pubkey>", "role": "member", "encrypted_group_key": "<...encrypted>"}'
```

## Testing

### Chain Test (Anchor rounds + payload + multi-validator)

```bash
# Run the helper script — it auto-fetches your node's pubkey and restarts with chain enabled
node prototypeC/scripts/run_chain_test.js

# Multi-validator mode (starts N nodes on separate ports, connects them as peers)
DDN_VALIDATORS_COUNT=3 node prototypeC/scripts/run_chain_test.js --multi

# Keep nodes running after tests complete
DDN_VALIDATORS_COUNT=3 node prototypeC/scripts/run_chain_test.js --multi --keep-running

# Skip browser auto-open
node prototypeC/scripts/run_chain_test.js --no-browser
```

### E2E Test (2-node peer sync + dApps + communities)

```bash
# In prototypeB/ — runs full 2-node e2e test including dApp discovery, private communities, runtime dir
node prototypeB/scripts/test_e2e.js
# Use --slow for longer delays, --keep-running to keep nodes up after tests
```

## Roadmap (see `PLAN.md` for details)

- **C-1**: Tauri shell (sidecar + tray + settings) — Complete
- **C-2**: Blockchain anchor chain + `/api/chain/*` endpoints — Complete
- **C-3**: Multi-dApp architecture (Guestbook served by node) — Complete
- **C-4**: Multi-validator consensus + `/api/chain/proposals`, `/api/chain/sign`, `/api/chain/commit` — Complete
- **C-5**: Private communities (`is_private`, group key, encrypted membership) — Complete
- **C-6**: Runtime dApp install + discovery + dir change — Complete
