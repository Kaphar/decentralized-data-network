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

## Running the sidecar manually (debugging)

```bash
DDN_HTTP_PORT=3000 DDN_P2P_PORT=4001 DDN_DATA_DIR=./data prototypeC/node/target/release/ddn-node
```

After starting the sidecar, the following are available:
- Main app: `http://127.0.0.1:3000/`
- Blockchain API: `http://127.0.0.1:3000/api/chain/block/latest`
- Guestbook dApp: `http://127.0.0.1:3000/dapp/guestbook`

## Roadmap (see `PLAN.md` for details)

- **C-1**: Tauri shell (sidecar + tray + settings) — Complete
- **C-2**: Blockchain anchor chain + `/api/chain/*` endpoints — Complete
- **C-3**: Multi-dApp architecture (Guestbook served by node) — In Progress
