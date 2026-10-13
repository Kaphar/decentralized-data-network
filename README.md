# MeshWall (alpha)

A tiny social app prototype — users, contacts, chat, image/video/text wall —
where **files and data are served by the nodes themselves**, not a central server.
No dependencies (Python 3.10+ stdlib + a browser). Design options & roadmap: [PLAN.md](PLAN.md).

## How it works (30-second version)

- Every file (image/video/…) is stored as a **blob** addressed by its sha256 hash → that hash *is* the address ("CID"). Same idea as IPFS, DIY for now.
- Every social entity (profile, contact-add, message, post) is a signed, **hash-linked JSON record**: `prev` points to the author's previous record → a per-user append-only "mini chain". Tamper-evident, no blockchain ops needed.
- Nodes sync **records** with peers (`POST /api/sync`). **Blobs are pulled on demand**: if your node doesn't have a CID, it fetches it from any known peer, verifies `sha256(bytes) == cid`, then caches it. A lying peer can't poison your store.
- The browser app is served by each node itself → open `http://localhost:<port>` and you're in.

## Quick start

### Windows (PowerShell)

```powershell
# Terminal 1 — alice's node
$env:MW_PEER_ID="alice"; $env:MW_PORT="4001"; $env:MW_DATA="./data/alice"
python -m mw.node

# Terminal 2 — bob's node (open a second PowerShell window, same folder)
$env:MW_PEER_ID="bob"; $env:MW_PORT="4002"; $env:MW_DATA="./data/bob"
python -m mw.node
```

One-liner variant per terminal (no leftover env vars between runs):

```powershell
cmd /c "set MW_PEER_ID=alice&& set MW_PORT=4001&& set MW_DATA=.\data\alice&& python -m mw.node"
```

If `python` isn't found, try `py -m mw.node` (Windows launcher) or `python3`.
If Python isn't installed: grab it from python.org and tick *"Add to PATH"* in the installer.

### Linux / macOS

```bash
# Terminal 1 — alice's node
MW_PEER_ID=alice MW_PORT=4001 MW_DATA=./data/alice python -m mw.node

# Terminal 2 — bob's node
MW_PEER_ID=bob   MW_PORT=4002 MW_DATA=./data/bob   python -m mw.node
```

Open http://localhost:4001 and http://localhost:4002 in two browsers.

## Workflow (first test run)

1. **Register** on each browser → creates your identity (dev mode: fixed demo id; real Ed25519 keys later, see below).
2. In the **Peers** panel of each node, add the other one: `http://localhost:4002` (and vice-versa), then hit **Sync**.
3. Post text or an image/video on the **Wall**; add a **Contact**; send a **DM**. Light polling keeps both views fresh; **Sync** pulls everything manually.
4. Watch decentralization happen: media uploaded to alice is rendered on bob's page — bob's node fetched the blob from alice by CID and cached it (check `data/bob/blobs/`).

## Tests

```bash
python3 tests/smoke_test.py

# Windows (PowerShell or cmd):
python tests\smoke_test.py
```

Boots two nodes on ports 4181/4182 (fresh dirs under `data/tA`, `data/tB`) and checks:
chain building, tamper rejection (400), bidirectional sync, shared walls/DMs,
decentralized blob fetch + caching, and 404 for unknown CIDs. Ends with `ALL SMOKE TESTS PASSED ✔`.

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `MW_PORT` | `4001` | HTTP port of this node |
| `MW_PEER_ID` | `node` | Name shown in logs |
| `MW_DATA` | `./data` | Per-node data dir (blobs, records, peers.json) |
| `MW_DEV_SECRET` | `meshwall-dev-secret` | Shared secret for dev-mode signing — must match across nodes |
| `MW_REAL_KEYS` | `0` | `1` = real Ed25519 signatures (needs `pip install cryptography`) |

⚠️ Alpha/dev mode only: dev signing proves *tamper-evidence*, not true per-user identity. Don't use outside a LAN demo until real keys + HTTPS.

## API cheat-sheet

| Endpoint | Purpose |
|---|---|
| `POST /api/blob` (raw bytes) → `{cid}` | Upload a file, get its content-address |
| `GET /blob/<cid>?name=x.png` | Serve file; auto-fetches from peers if missing |
| `POST /api/record` (signed JSON) → `{id}` | Append to a user's chain (validates sig + prev) |
| `GET /api/wall` / `/api/users` / `/api/contacts?user=` / `/api/dm?me=&other=` | Read views |
| `GET /api/since?ts=<n>` | Raw sync feed (full records newer than n) |
| `POST /api/peers {url}` / `GET /api/peers` | Peer bookkeeping |
| `POST /api/sync` | Pull all records from known peers (returns #newly added) |

## Repo layout

```
mw/core.py    CAS store + record chain + signing/verification (the protocol core)
mw/node.py    stdlib HTTP node: REST API, peer sync, decentralized blob fetch, serves web/
web/          zero-build SPA (index.html / app.js / style.css)
tests/        smoke_test.py — end-to-end two-node mesh test
PLAN.md       design options explored (file serving, chain-vs-no-chain, discovery…)
data/         runtime state (gitignored) — one folder per node
```

## Next steps (pick one, see PLAN.md phases)

- mDNS auto-discovery on the LAN (no manual peer entry)
- WebSocket push instead of polling for chat
- Real Ed25519 identities generated in-browser (`MW_REAL_KEYS=1` path)
- Blob replication/pinning policy (what should my node keep?)
