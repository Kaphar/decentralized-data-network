


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




4. Data Model: Record Schema
Every piece of data is a signed, hash-linked JSON record. The id is the SHA-256 hash of the canonicalized JSON (excluding the sig field).
Base Record Structure
{
  "id":      "<sha256_cid_of_this_record>",
  "type":    "profile | post | comment | reaction | message | media_offer | media_accept | report | mod_action | mod_grant",
  "author":  "<ed25519_pubkey_multihash>",
  "prev":    "<cid_of_authors_previous_record_or_null>",
  "ts":      1728900000,
  "payload": { ... },
  "sig":     "<ed25519_signature_over_id>"
}

Payload Extensions
post: { "text": "...", "media": [ { "cid": "...", "mime": "image/jpeg", "size": 1024 } ] } (Media < 2MB stored encrypted in CAS)
comment: { "target_cid": "<cid_of_post>", "text": "..." }
reaction: { "target_cid": "<cid_of_post_or_comment>", "emoji": "👍" }
message (E2EE DM): { "to": "<recipient_pubkey>", "ciphertext": "<base64>", "nonce": "<base64>", "ephemeral_pubkey": "<x25519_pubkey>" }
media_offer (Large file via WebRTC): { "target_user": "<recipient_pubkey>", "file_name": "video.mp4", "size_bytes": 15000000, "ephemeral_pubkey": "<x25519_pubkey>" }
media_accept: { "offer_cid": "<cid_of_media_offer>", "ephemeral_pubkey": "<x25519_pubkey>" } (Triggers WebRTC handshake)
report: { "target_cid": "<cid_of_content>", "reason": "explicit_content" }
mod_action: { "target_cid": "<cid_of_content>", "action": "hide" | "nuke", "mod_pubkey": "<pubkey>" }
mod_grant: { "new_mod_pubkey": "<pubkey>", "signed_by": "<admin_pubkey>" }
5. Key Management & Security Flow
The "No Admin Reset" Rule: To maintain true E2EE, the server/admin must never possess the user's private key.
Onboarding: User enters a local password. The browser/node generates an Ed25519 keypair.
Encryption: The private key is encrypted locally using a key derived from the password (via Argon2 or PBKDF2).
Mandatory Backup: The app forces the user to download meshwall_backup.json (containing the encrypted private key and salt). The app will not proceed without this download.
Login: User provides the .json file and password. The client decrypts the key in memory. The plaintext key never leaves the local environment.
Loss Scenario: If the user loses both the file and the password, the account is permanently unrecoverable. The admin can only assist in creating a new account.
6. Moderation & Governance Model
Since we cannot cryptographically force a node to delete data it already has, moderation is enforced via visibility control and routing refusal.
Trusted Moderators: The client ships with a hardcoded "Admin" public key. The admin can publish mod_grant records to promote trusted moderators. Clients maintain a local, cryptographically verified list of active mods.
Community Reporting: Any user can publish a report record. This does not hide content; it merely gossips the flag to the network for the moderation team's dashboard.
Moderator Action: A mod reviews reports and publishes a signed mod_action record.
Enforcement:
Client-Side: Clients subscribed to a mod's public key will automatically blur/hide any target_cid marked with action: "hide".
Node-Side: Node operators can configure their software to subscribe to a trusted mod's blocklist. The node will actively refuse to store or serve any blob matching a nuke action, protecting the operator from legal liability.
7. Media Handling Strategy
Small Media (Profile pics, post images < 2MB): Encrypted client-side → Uploaded to local CAS → CID shared in the post record.
Large Media (Short videos, large files): Sender publishes a media_offer record. Recipient replies with media_accept. Both clients use these records to establish a direct WebRTC Data Channel. The encrypted file streams directly peer-to-peer, bypassing node storage entirely.
8. Development & Testing Strategy (No VPS Required)
Tier 1: Local LAN Testing (Zero Config): Use libp2p::mdns (Multicast DNS). Running multiple Rust nodes on the same local machine/Wi-Fi will automatically discover each other without any bootstrap configuration.
Tier 2: Cross-Internet Testing (Free): When testing with external peers, run a dedicated "Bootstrap Node" locally and expose it to the internet for free using Cloudflare Tunnels (cloudflared). Hardcode this tunnel address into the Rust node's config as a bootstrap peer.
9. Phased Roadmap
Phase
Deliverable
Est. Effort
0 (Current)
Runnable skeleton: Basic Rust CAS, hash-linked records, SolidJS frontend shell, manual peer config, plaintext text/image posts.
Done / In Progress
1
libp2p Integration: Implement libp2p-rust (Kademlia DHT, Gossipsub, mDNS). Add mandatory .json key export UX. Replace polling with WebSocket push from Rust node to SolidJS.
~2 weeks
2
E2EE & WebRTC: Implement X25519 + AES-GCM for DMs. Build the media_offer/media_accept signaling flow and establish WebRTC Data Channels for large file transfers.
~3 weeks
3
Moderation System: Implement report, mod_grant, and mod_action record types. Build client-side filtering based on trusted mod pubkeys. Add node-level blocked_cids enforcement.
~2 weeks
4
Hardening & Scale: Refine Rust/Tauri integration if needed. Evaluate migrating the custom CAS to IPFS/Kubo for better global chunking and NAT traversal.
Open