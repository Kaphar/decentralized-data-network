# mw — "MeshWall" alpha core package
#
# Design (see PLAN.md):
#  * CAS: content-addressed blob store, sha256 hex = id ("CID"). Files
#    (images/videos) and records both live here.
#  * Chain: every social entity is a signed, hash-linked JSON record
#    (profile/contact/message/post). Records are also stored as CAS blobs,
#    so their CID is their immutable id.
#  * Node: plain-HTTP REST server. Any node can serve any blob/record it
#    knows about; nodes sync by pulling each other's record index.
#
# Zero required dependencies (stdlib only). Signing has two modes:
#   - dev mode (default): sig = "dev:" + sha256(secret || canonical body)
#     -> tamper-evident demo, no real per-user identity yet.
#   - real mode (MW_REAL_KEYS=1, needs `cryptography`): Ed25519 per user,
#     author id = "ed25519:<base64 pubkey>".

import hashlib
import json
import os
import time
from urllib.parse import urlparse

DATA_DIR = os.environ.get("MW_DATA", "./data")
PEER_ID = os.environ.get("MW_PEER_ID", "node")
PORT = int(os.environ.get("MW_PORT", "4001"))
DEV_SECRET = os.environ.get("MW_DEV_SECRET", "meshwall-dev-secret")
REAL_KEYS = os.environ.get("MW_REAL_KEYS", "0") == "1"


def self_url() -> str:
    """This node's own reachable URL (used to skip self in peer probes)."""
    return f"http://127.0.0.1:{PORT}"


def is_local(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host in ("localhost", "127.0.0.1", "::1", "0.0.0.0")


def canon(obj) -> bytes:
    """Deterministic JSON encoding."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def cid_of(data: bytes) -> str:
    """Content id: sha2-256 hex (IPFS-multihash-compatible payload)."""
    return hashlib.sha256(data).hexdigest()


class Store:
    """On-disk content-addressed store + record index."""

    def __init__(self, root: str):
        self.blobs = os.path.join(root, "blobs")
        self.records_dir = os.path.join(root, "records")
        os.makedirs(self.blobs, exist_ok=True)
        os.makedirs(self.records_dir, exist_ok=True)

    # ---- CAS blobs -------------------------------------------------------
    def put_blob(self, data: bytes) -> str:
        c = cid_of(data)
        p = os.path.join(self.blobs, c)
        if not os.path.exists(p):
            with open(p, "wb") as f:
                f.write(data)
        return c

    def get_blob(self, c: str) -> bytes | None:
        try:
            with open(os.path.join(self.blobs, c), "rb") as f:
                return f.read()
        except FileNotFoundError:
            return None

    # ---- records ---------------------------------------------------------
    def put_record(self, rec: dict) -> str:
        """Store a record under its PROTOCOL id:
           id == sha256hex(canon(record minus 'id'))  i.e. body+sig hash.

        This matches web/app.js deriveId() and core.verify(). Do NOT key
        records by sha256(full record incl. id) — that produced a second,
        inconsistent id space and broke chain linking from the browser."""
        rid = rec["id"]
        rpath = os.path.join(self.records_dir, rid)
        if not os.path.exists(rpath):
            self.put_blob(canon(rec))    # raw bytes stay retrievable by CID
            with open(rpath, "wb") as f:
                f.write(canon(rec))
        return rid

    def get_record(self, c: str) -> dict | None:
        p = os.path.join(self.records_dir, c)
        try:
            with open(p, "rb") as f:
                return json.loads(f.read())
        except FileNotFoundError:
            return None

    def all_records(self) -> list:
        out = []
        for name in sorted(os.listdir(self.records_dir)):
            rec = self.get_record(name)
            if rec:
                out.append(rec)
        return out

    def chain_of(self, author: str) -> list:
        recs = [r for r in self.all_records() if r["author"] == author]
        recs.sort(key=lambda r: r["ts"])
        return recs

    def head_of(self, author: str):
        recs = self.chain_of(author)
        return recs[-1]["id"] if recs else None

    def has_record(self, c: str) -> bool:
        """Cheap existence check (no file read)."""
        return os.path.isfile(os.path.join(self.records_dir, c))


# ---------------------------------------------------------------------------
# Signing / verification
# ---------------------------------------------------------------------------
import base64

try:  # optional dependency — enables real Ed25519 identities
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PrivateKey, Ed25519PublicKey,
    )
    from cryptography.hazmat.primitives.serialization import (
        Encoding, PublicFormat,
    )
    HAS_CRYPTO = True
except ImportError:
    HAS_CRYPTO = False


def _load_key(secret: str):
    seed = hashlib.sha256(secret.encode()).digest()
    return Ed25519PrivateKey.from_private_bytes(seed)


def pubkey_id(secret: str) -> str:
    """Deterministic user id from a secret seed: 'ed25519:<base64 pubkey>'."""
    if not HAS_CRYPTO:
        raise RuntimeError("pip install cryptography to use real keys")
    pk = _load_key(secret).public_key()
    raw = pk.public_bytes(Encoding.Raw, PublicFormat.Raw)
    return "ed25519:" + base64.b64encode(raw).decode()


def sign(body: dict, secret: str) -> str:
    """Sign a record body. REAL_KEYS + cryptography => Ed25519; else dev HMAC.

    NOTE: `body` must NOT contain an "id" field — the id is derived from the
    signed content afterwards (see make_record / protocol contract in PLAN.md).
    """
    if REAL_KEYS and HAS_CRYPTO:
        key = _load_key(secret)
        return base64.b64encode(key.sign(canon(body))).decode()
    return "dev:" + hashlib.sha256(
        secret.encode() + canon(body)
    ).hexdigest()


def verify(rec: dict) -> bool:
    """Verify one record.

    Dev mode : sig is an HMAC-style digest over the canonical body using the
               shared MW_DEV_SECRET (demo tamper-evidence only).
    Real mode: author id embeds the pubkey ("ed25519:<b64>") and sig is a real
               Ed25519 signature over the canonical body WITHOUT the sig/id
               fields.
    Also re-checks that rec["id"] == sha256(canonical(signed-content + sig)),
    so a forged id can't slip through.
    """
    body = {k: v for k, v in rec.items() if k not in ("sig", "id")}
    signed_bytes = canon({**body, "sig": rec.get("sig")})
    if rec.get("id") != cid_of(signed_bytes):
        return False
    if str(rec.get("sig", "")).startswith("dev:"):
        expected = "dev:" + hashlib.sha256(
            DEV_SECRET.encode() + canon(body)
        ).hexdigest()
        return rec["sig"] == expected
    try:
        raw = base64.b64decode(str(rec["author"]).split(":", 1)[1])
        pk = Ed25519PublicKey.from_public_bytes(raw)
        pk.verify(base64.b64decode(rec["sig"]), canon(body))
        return True
    except Exception:
        return False


def make_record(type_: str, author: str, prev, payload: dict,
                secret: str = DEV_SECRET, ts: int | None = None) -> dict:
    body = {
        "type": type_,
        "author": author,
        "prev": prev,
        "ts": ts if ts is not None else int(time.time()),
        "payload": payload,
    }
    sig = sign(body, secret)
    full = {**body, "sig": sig}
    full["id"] = cid_of(canon(full))
    return full


def validate_chain(recs: list) -> bool:
    """Check hash-links + signatures of one author's chain (sorted by ts)."""
    recs = sorted(recs, key=lambda r: r["ts"])
    prev_id = None
    for r in recs:
        if r["prev"] != prev_id:
            return False
        if not verify(r):
            return False
        if r["id"] != cid_of(canon({k: v for k, v in r.items()})):
            pass  # id already checked at insert; kept loose for flexibility
        prev_id = r["id"]
    return True
