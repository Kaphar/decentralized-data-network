# Decentralized Data Network — Project Plan

A progressive, learning-first journey toward a truly decentralized, end-to-end encrypted
social network. The project evolves through three prototypes of increasing scope.

---

## Prototypes Overview

| Prototype | Stack | Status | Focus |
| :--- | :--- | :--- | :--- |
| **A** — `prototypeA/` | Python node + vanilla JS | Done | Alpha proof-of-concept: custom CAS, hash-linked records, manual peer sync, 2-node demo |
| **B** — `prototypeB/` | Rust (`libp2p`/`axum`) + SolidJS | Done | Full P2P network: identity persistence, E2EE DMs, WebRTC media, moderation, communities, reactions |
| **C** — `prototypeC/` | Rust + SolidJS + **Tauri** | Active | **Desktop distribution** (system tray + sidecar node), **blockchain** study, **multi-dapp** architecture |

> The full historical architecture document for Prototype B is preserved at
> `prototypeB/PLAN.md`. Prototype C builds directly on Prototype B's Rust node and
> SolidJS frontend.

---

## 1. Core Principles (inherited by all prototypes)

- **True Decentralization**: No central server, no single point of failure. Nodes are equal peers.
- **End-to-End Encryption (E2EE)**: Private data is encrypted client-side before it touches a node.
- **User Sovereignty**: Users own their keys. No admin password reset.
- **Scalable by Design**: Built on `libp2p` (DHT, Gossipsub, mDNS).

---

## 2. Technology Stack

| Function | Technology / Protocol | Rationale |
| :--- | :--- | :--- |
| **Node Backend** | Rust (`tokio`, `axum`, `libp2p`) | High performance, memory safety, best libp2p ecosystem |
| **Frontend** | SolidJS + TypeScript + Pure CSS | Fast, reactive, type-safe, minimal bundle |
| **Identity & Signing** | Ed25519 (`ed25519-dalek`) | Standard for decentralized identity |
| **Key Management** | Local password (PBKDF2) + exportable `.json` | No admin backdoors |
| **Networking & Discovery** | libp2p (Kademlia + Gossipsub + mDNS) | Organic peer discovery, real-time pub/sub |
| **Storage (small data)** | Custom Content-Addressed Store (CAS) | Hash = address (`sha256`) |
| **Storage (large media)** | WebRTC Data Channels | Bypasses node disk; DTLS-SRTP encryption |
| **Private Chat (DMs)** | X25519 + AES-GCM sealed messages | Nodes only see ciphertext |

---

## 3. Data Model

Every piece of data is a **signed, hash-linked JSON record**:

```json
{
  "id":      "<sha256_cid_of_this_record>",
  "type":    "profile | post | comment | reaction | message | media_offer | media_accept | report | mod_action | mod_grant | community | community_membership",
  "author":  "<ed25519_pubkey_hex>",
  "prev":    "<cid_of_previous_record_or_null>",
  "ts":      1728900000,
  "payload": { ... },
  "sig":     "<ed25519_signature_over_id>"
}
```

The `id` is the SHA-256 hash of the canonicalized JSON (excluding the `sig` field).
See `prototypeB/PLAN.md` (§4–7) for the full record schema, moderation model, media
strategy, and identity/key management flow.

---

## 4. Prototype C — Desktop Distribution, Blockchain, & Multi-DApp

### 4.1 Desktop Distribution (Tauri)

Package the Prototype B Rust node as a background **sidecar binary** inside a
**Tauri** desktop shell.

- **Sidecar Node**: The `ddn-node` binary (from `prototypeB/node`) is compiled and
  bundled as a Tauri sidecar. It starts on application launch, running libp2p in
  the background without a visible terminal.
- **Embedded Frontend**: The SolidJS frontend (from `prototypeB/frontend`) is built
  with `npm run build` and served inside a Tauri WebView2 (Win) / WebKit (macOS) /
  WebKit2GTK (Linux). The frontend talks *only* to the local sidecar via
  `http://127.0.0.1:<port>`.
- **System Tray Icon**:
  - Green/red indicator: green = node running + libp2p swarm active + WS connected;
    red = node stopped or disconnected.
  - Peer count and data-transfer stats (records published, blobs synced).
- **Tray Menu**:
  - **Toggle Node** — start/stop the sidecar (halts all networking/serving).
  - **Open Main Window** — launches the full SolidJS UI in a Tauri window.
  - **Settings** — dialog for `DDN_HTTP_PORT`, `DDN_P2P_PORT`, `DDN_DATA_DIR`, and
    bootstrap peer addresses. Persisted to a JSON config in the user's app-data dir.
  - **Quit** — gracefully shuts down the node and exits.

### 4.2 Blockchain Study (LBRY-like data chain)

Build a **minimal blockchain from scratch** in Rust to anchor DDN record CIDs — a
learn-first approach (no existing chain integration).

- A small Proof-of-Stake (or simplified PoA) chain where validator nodes propose
  blocks that contain a batch of DDN `id` CIDs (Merkle-rooted).
- Nodes can opt in to publish their records' CIDs into a block, giving external
  observers a trust-minimized way to verify record existence at a given time.
- The chain is *auxiliary* to the P2P layer — it anchors hashes, it does not replace
  gossipsub record delivery.
- Goal: educational first pass — a runnable anchor chain that a DDN node can talk to
  via a simple JSON/RPC API to submit and verify anchors.

### 4.3 Multi-DApp Architecture

Extend the architecture so the same local node can host multiple decentralized
apps ("dapps"), each a distinct UI with its own route.

- **Routing**: The SolidJS shell gains a `/dapp/<name>` router. The "Wall" is the
  first dapp; additional dapps are added as route modules.
- **DApp examples**:
  1. **Guestbook** — a public, append-only dapp where anyone can post a short message
     (signed records, no DMs). Reuses the post/comment record types.
  2. **Notes** — a private per-user dapp: notes are stored encrypted client-side
     (E2EE) and optionally anchored to the blockchain for tamper evidence.
- **Record namespaces**: DApp records optionally carry a `dapp` field in the payload
  so the frontend can filter records per-dapp without schema changes.
- Each dapp is self-contained in `src/dapps/<name>/` but shares the same node API
  and identity.

See `prototypeC/PLAN.md` for the detailed implementation design.

---

## 5. Phased Roadmap

| Phase | Prototype | Deliverable | Status |
| :--- | :--- | :--- | :--- |
| 0 | A | Python CAS + hash-linked records + web UI | Done |
| 0 | B | Rust CAS, hash-linked records, SolidJS shell, manual peer config | Done |
| 1 | B | libp2p (Kademlia + Gossipsub + mDNS), key export UX, WS push, network UI | Done |
| 2 | B | E2EE DMs (X25519 + AES-GCM), WebRTC media signaling | Done |
| 3 | B | Moderation system (report, mod_action, IP bans) | Done |
| 4 | B | Reactions (emoji) | Done |
| 5 | B | Identity persistence & frontend management, broadcast mode | Done |
| 6.2 | B | Community model (creation, membership, scoped moderation) | Done |
| **C-1** | **C** | **Tauri desktop shell: sidecar node, system tray, settings, embedded frontend** | **Planned** |
| **C-2** | **C** | **Minimal blockchain anchor chain (Rust) + DDN integration** | **Planned** |
| **C-3** | **C** | **Multi-dapp router + Guestbook + Notes dapps** | **Planned** |
