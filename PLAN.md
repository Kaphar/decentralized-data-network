# Decentralized Data Network - Architecture & Implementation Plan (Prototype B)

## 1. Core Principles
- **True Decentralization**: No central server, no single point of failure. Nodes are equal peers.
- **End-to-End Encryption (E2EE)**: Private data (DMs, private media) is encrypted *client-side* before it ever touches a node. Nodes only store and route ciphertext.
- **User Sovereignty**: Users own their cryptographic keys. There is **no admin password reset**. Loss of the local key file and password means permanent loss of that specific identity and its private data.
- **Scalable by Design**: Built on `libp2p` primitives (DHT, Gossipsub) to support a large, open network, avoiding the bottlenecks of manual peer lists or HTTP polling.

---

## 2. Technology Stack Choices

| Function | Technology / Protocol | Rationale |
| :--- | :--- | :--- |
| **Node Backend** | **Rust** (`tokio`, `axum`) | High performance, memory safety, excellent `libp2p` ecosystem (`libp2p-rust`). |
| **Frontend** | **SolidJS + TypeScript + Pure CSS** | Fast, reactive, type-safe, minimal bundle size. No heavy framework overhead. |
| **Identity & Signing** | Ed25519 (via `ed25519-dalek`) | Fast, secure, standard for decentralized identity (`did:key`-style). |
| **Key Management** | Local password (Argon2/PBKDF2) + Exportable `.json` key file | Prevents admin backdoors. User is solely responsible for backup. |
| **Networking & Discovery** | **libp2p** (Kademlia DHT + Gossipsub + mDNS) | Enables organic peer discovery and efficient, real-time pub/sub. |
| **Storage (Small Data)** | Custom Content-Addressed Store (CAS) | Simple, dependency-light storage for text/JSON records. Hash = Address (`sha256`). |
| **Storage (Large Media)** | **WebRTC Data Channels** | Bypasses node storage entirely. Native DTLS-SRTP encryption. Ideal for short videos/large files. |
| **Private Chat (DMs)** | X25519 Key Exchange + AES-GCM (or `crypto_box`) | Ensures nodes only ever see ciphertext. |

---

## 3. Local Architecture & Project Structure

Browsers cannot open raw TCP/UDP sockets for P2P networking. We use a **Local Gateway Model**:
1. **The Rust Node (The Engine)**: Runs `libp2p`, holds the user's identity, handles all signing/encryption, and runs a local HTTP/WebSocket server (`axum`).
2. **The SolidJS Frontend (The UI)**: Runs in the browser, talks *only* to the local Rust node via local HTTP/WebSocket. It focuses purely on UI and state management.

### Proposed Monorepo Structure
```text
decentralized-data-network/
├── PLAN.md                 # This architecture document
├── node/                   # The Rust Backend
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs         # Axum HTTP server + libp2p swarm initialization
│       ├── p2p/            # libp2p behaviors (gossipsub, kad, mdns)
│       ├── crypto/         # Ed25519 signing, X25519/AES-GCM encryption
│       ├── storage/        # The local Content-Addressed Store (CAS)
│       └── records/        # Rust structs for the JSON schemas
├── frontend/               # The SolidJS Frontend
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.tsx        # SolidJS entry point
│       ├── App.tsx         # Root component
│       ├── components/     # UI components (Post, Comment, Chat)
│       ├── api/            # Functions to call the local Rust node
│       ├── styles/         # Pure CSS files
│       └── types.ts        # TypeScript interfaces matching Rust records
└── scripts/                # Helper scripts (e.g., generating test keys)