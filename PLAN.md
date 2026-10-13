# Decentralized Social App — Alpha Plan

Working title: **MeshWall** (rename freely)

Goal: a browser-openable social app (users, contacts, chat, wall posts with
images/videos/text) where files and data are served by peer nodes on a LAN/P2P
network — no central server as a hard dependency, ideally no "real" blockchain.

---

## 1. Core design decisions (options)

### A. File serving / storage

| Option | What it is | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A1. IPFS (Kubo node or `ipfs` http gateway)** | Content-addressed storage, each peer runs an IPFS node | Battle-tested, content hashes = natural "blocks", browsers can fetch via `http://localhost:8080/ipfs/<cid>` | Heavier runtime, pinning strategy needed | Best long-term; easy to adopt later |
| **A2. Rolling your own content-addressed store (CAS)** | Each node stores blobs under `sha256(bytes)` in a local folder, serves them over HTTP | ~100 lines of code, zero deps, same "hash = address" idea as IPFS | No NAT traversal / global DHT (fine for LAN alpha) | **Use this for the first test** |
| **A3. BitTorrent-style chunks + tracker** | Split files, peers exchange pieces | Great for big video | Overkill now | Later, if media gets large |
| **A4. Central-ish origin + CDN cache** | One node holds truth | Simple | Not what you asked for | Reject |

Recommendation: start with **A2**, keep CID format compatible with IPFS
multihash (`sha2-256`) so migrating to **A1** later is mostly swapping the
fetch layer.

### B. Data integrity / "chain-like" protocol (without a real blockchain)

You don't need mining or consensus-by-stake. For a social alpha, a
**hash-linked append-only log per user** ("personal chain") is enough:

- Every entity (profile, contact-add, message, post) is a signed JSON record:
  `{ id, type, author, prev, ts, payload }` where `prev` is the hash of the
  author's previous record → tamper-evident chain per user.
- Records are stored as blobs in the CAS → their CID *is* the immutable ID.
- Nodes gossip records (pull latest heads from peers periodically).
- Conflict rule (alpha): longest valid chain wins; ties broken by timestamp.

This gives you 90% of blockchain benefits (immutability, identity, audit trail)
with none of the operational pain. If you later want real consensus, options:

| Option | Notes |
|---|---|
| **B1. Hash-linked log only** (recommended alpha) | No agreement needed between nodes; each user signs their own chain |
| **B2. Gossip + last-write-wins CRDTs** | Better for concurrent chat edits; more theory |
| **B3. Libp2p + pubsub + custom DAG (Iroh / libp2p)** | Real P2P networking without blockchain |
| **B4. Actual chain (Substrate, Cosmos, L2)** | Only if you need multi-party trust / token economy |

### C. Networking / discovery (LAN alpha)

| Option | How | Use when |
|---|---|---|
| **C1. Manual peer list** | config file with `http://host:port` of friends' nodes | First test ✔ |
| **C2. mDNS/UDP broadcast discovery** | nodes announce themselves on LAN | Phase 2 |
| **C3. WebRTC data channels (signaled via C1/C2)** | browser-to-browser direct | Phase 3 (true web3 feel) |
| **C4. libp2p / iroh** | production-grade DHT, NAT traversal | Phase 4 |

### D. Chat transport

- **D1. Poll-based sync (alpha):** messages are just chain records; UI polls
  `/sync` every 2s. Dead simple, works over plain HTTP. ✔
- **D2. WebSocket relay per node:** push between local UI and its own node.
- **D3. WebRTC / libp2p-gossipsub:** direct encrypted P2P. Later.

### E. Frontend

- **E1. Vanilla HTML/JS served by each node** (zero build step — best for alpha ✔)
- **E2. Vite + React/Vue/Svelte** once UI grows
- **E3. Real Web3 stack (ethers/wagmi + smart contracts)** only if you pick B4

### F. Identity & keys

- **F1. Ed25519 keypair per user, generated in browser (WebCrypto), private key
  in localStorage** — fine for alpha ✔
- **F2. Passkeys / IndexedDB-backed keystore** — nicer UX later
- Public key hash = user ID (`did:key`-style). Signatures verified by every node.

---

## 2. Record schema (the heart of the protocol)

```json
{
  "id":      "<cid of this record>",        // sha256 of canonical JSON below
  "type":    "profile | contact | message | post",
  "author":  "<user id / pubkey multihash>",
  "prev":    "<id of author's previous record or null>",
  "ts":      1728900000,                    // unix seconds
  "payload": { ... },                       // see below
  "sig":     "<ed25519 sig over id>"
}
```

Payloads:
- `profile`: `{ name, bio }`
- `contact`: `{ add: <userId> }`
- `message`: `{ to: <userId>, text }`            (DM) / `{ room, text }` (later)
- `post`:    `{ text?, media: [ { cid, mime } ] }`   ← media fetched from any node's CAS

Chain rules: `prev` must exist, author signature must verify, ts monotonic per author.

---

## 3. Roadmap

| Phase | Deliverable | Est. |
|---|---|---|
| **0 (this commit)** | Runnable skeleton: Python node (CAS + record store + REST), 2-node demo, vanilla JS frontend: register user, add contact, post text+image to wall, DM chat via polling | done ✔ |
| **1** | mDNS discovery, auto-sync loop between known peers, media preview thumbnails, multiple concurrent users per browser profile | ~1 wk |
| **2** | Replace polling with WebSocket push; per-user outbox/inbox model; garbage-collect unpinned blobs; basic spam limits | ~1–2 wk |
| **3** | WebRTC direct connections (browser↔browser via signaling through nodes); end-to-end encrypted DMs (sealed box per recipient) | ~2–3 wk |
| **4** | Evaluate migration: plug in IPFS Kubo or libp2p/iroh for transport+CAS; optional light "consensus" (node-signed checkpoints) if you ever want multi-party trust | open |

---

## 4. Quickstart (Phase 0)

```bash
cd /workspace
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

# Terminal 1 — Alice's node
MW_PEER_ID=alice MW_PORT=4001 MW_DATA=./data/alice python -m mw.node

# Terminal 2 — Bob's node
MW_PEER_ID=bob   MW_PORT=4002 MW_DATA=./data/bob   python -m mw.node

# Open http://localhost:4001 (and 4002 in another browser)
# Register a user on each, then use Settings→Peers to add the other node,
# post to the wall / send a DM and hit Sync.
```

No browser-side build step; the frontend is static files served by the node.

## 5. Open questions to explore next

1. Pinning policy: who keeps copies of whose media? (Author pins own posts;
   viewers optionally replicate → later incentive/reputation system.)
2. Moderation/reporting in an append-only world → tombstone records (`type: delete`) that hide but don't erase.
3. Group walls vs personal walls (rooms as shared multi-author chains?).
4. Do we want native-app packaging (Tauri) so nodes run quietly on desktops?
