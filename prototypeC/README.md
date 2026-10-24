# Prototype C — Desktop Distribution + Blockchain + Multi-DApp

Builds on Prototype B (`prototypeB/`) — reuses the Rust `ddn-node` and the SolidJS
frontend. Prototype C adds: a Tauri desktop shell with system tray, a minimal
blockchain anchor chain, and a multi-dApp router.

See `PLAN.md` at the repository root and `prototypeC/PLAN.md` for the full design.

## Components

| Component | Description |
| :--- | :--- |
| **Tauri shell** (`src/main.rs`, `tauri.conf.json`) | Desktop window + system tray. Spawns `ddn-node` as a sidecar with config from `%APPDATA%\ddn\config.json`. |
| **Sidecar node** (`node/`) | Copy of the Prototype B Rust node. Compiled as `ddn-node` and bundled by Tauri. |
| **Embedded frontend** (`frontend/`) | Copy of the Prototype B SolidJS app. Built with `npm run build`; the output is served in a WebView and targets `127.0.0.1`. |

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

## Roadmap (see root PLAN.md §5)

- **C-1**: Tauri shell (sidecar + tray + settings) — Planned
- **C-2**: Blockchain anchor chain + `/api/chain/*` endpoints — Planned
- **C-3**: Multi-dApp router + Guestbook + Notes — Planned
