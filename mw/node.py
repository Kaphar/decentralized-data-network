# MeshWall alpha node — stdlib-only HTTP server.
#
# Run:  MW_PEER_ID=alice MW_PORT=4001 MW_DATA=./data/alice python -m mw.node
#
# REST API
#  GET  /api/whoami                  -> {peer, port}
#  POST /api/blob                    -> raw bytes body            -> {cid}
#  GET  /blob/<cid>                  -> raw bytes (any file/media) -> 404 if unknown
#  POST /api/record                  -> JSON signed record         -> {id}
#  GET  /api/record/<cid>            -> JSON record
#  GET  /api/index                   -> [ {id, type, author, ts} ]  (light index)
#  GET  /api/since?ts=<n>            -> full records newer than ts (sync feed)
#  GET  /api/wall                    -> posts (type=post), newest first, w/ profiles
#  GET  /api/users                   -> latest profile per author
#  GET  /api/contacts?user=<author>  -> contact adds for a user
#  GET  /api/dm?me=<a>&other=<b>     -> messages between two users
#  POST /api/peers        {url}      -> remember a peer node
#  GET  /api/peers                   -> known peers (+ how they were found)
#  POST /api/sync                    -> pull records from all known peers
#  GET  /api/discovery               -> mDNS announce/browse status
#  GET  /api/profile?user=<id>       -> profile of one user (may fetch via peers)
#  POST /api/contact      {author,add}-> add contact by full key/id
#  GET  /*                           -> static files from ./web (the SPA)

import json
import os
import sys
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import urlparse, parse_qs, quote

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from mw import core  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(ROOT, "web")

store = core.Store(core.DATA_DIR)
PEERS_FILE = os.path.join(core.DATA_DIR, "peers.json")

MDNS_ENABLED = os.environ.get("MW_MDNS", "1") == "1"
MDNS_TYPE = "_meshwall._tcp.local."


def load_peers() -> dict:
    """{url: {"discovered": bool, "last_seen": ts}} — legacy list tolerated."""
    try:
        with open(PEERS_FILE) as f:
            raw = json.load(f)
    except FileNotFoundError:
        return {}
    if isinstance(raw, list):          # old format: plain URL list
        return {u: {"discovered": False, "last_seen": 0} for u in raw}
    return raw


def save_peers(peers: dict):
    with open(PEERS_FILE, "w") as f:
        json.dump(peers, f)


def add_peer(url: str, discovered=False):
    url = url.rstrip("/")
    peers = load_peers()
    if url == core.self_url() or url.endswith(f":{core.PORT}") and core.is_local(url):
        return peers  # never add ourselves
    entry = peers.setdefault(url, {"discovered": False, "last_seen": 0})
    entry["discovered"] = entry["discovered"] or discovered
    peers[url] = entry
    save_peers(peers)
    return peers


def peer_urls() -> list:
    return list(load_peers().keys())

# ---------- mDNS service discovery (LAN, stdlib zeroconf if installed) ------
try:
    from zeroconf import (ServiceBrowser, ServiceInfo, TypeListener,
                          Zeroconf)
    HAS_ZEROCONF = True
except ImportError:
    HAS_ZEROCONF = False

_zc = None
_mdns_state = {"announced": False, "error": None if HAS_ZEROCONF
               else "pip install zeroconf to enable LAN discovery"}


class _MwListener(TypeListener if HAS_ZEROCONF else object):
    """React to services appearing/disappearing on the LAN."""

    def add_service(self, zc, type_, name):
        global _mdns_state
        try:
            info = zc.get_service_info(type_, name, timeout=1500)
            if not info:
                return
            addr = ".".join(map(str, info.addresses[0])) if info.addresses \
                else "localhost"
            url = f"http://{addr}:{info.port}"
            if url.rstrip("/") != core.self_url():
                before = set(peer_urls())
                add_peer(url, discovered=True)
                if url not in before:
                    self.log(f"mDNS found peer {url} ({name})")
                    try:
                        Handler.sync_all()
                    except Exception:
                        pass
        except Exception as e:
            _mdns_state["error"] = f"browse: {e}"

    def remove_service(self, zc, type_, name):
        pass

    @staticmethod
    def log(msg):
        sys.stderr.write(f"[{core.PEER_ID}] {msg}\n")

    def update_service(self, zc, type_, name):
        self.add_service(zc, type_, name)


def mdns_start():
    """Announce this node + browse for others. Call once at startup."""
    global _zc, _mdns_state
    if not MDNS_ENABLED or not HAS_ZEROCONF:
        return
    try:
        _zc = Zeroconf()
        desc = {"peer": core.PEER_ID}
        if_name = os.environ.get("MW_BIND_IP")
        args = ([if_name], ) if if_name else ([b"0.0.0.0"], )
        info = ServiceInfo(MDNS_TYPE,
                           f"{core.PEER_ID}.{MDNS_TYPE}",
                           *args, port=core.PORT, weights=[0], ttl=120,
                           properties=desc)
        info.register_server(_zc)
        _zc.register_service(info)
        _zc.add_service_listener(MDNS_TYPE, _MwListener())
        ServiceBrowser(_zc, MDNS_TYPE, _MwListener())
        _mdns_state["announced"] = True
    except Exception as e:
        _mdns_state["error"] = str(e)


def mdns_stop():
    global _zc
    try:
        if _zc:
            _zc.close()
    except Exception:
        pass


def http_json(url: str, data=None, headers=None) -> dict:
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())


def _fetch_from_peers(cid: str):
    """Look up a record by CID from known peers; cache it locally if valid."""
    for url in peer_urls():
        try:
            rec = http_json(f"{url}/api/record/{cid}")
        except Exception:
            continue
        if "error" in rec:
            continue
        try:
            if core.verify(rec):
                store.put_record(rec)
                return rec
        except Exception:
            pass
    return None


def _http_raw(url: str) -> bytes | None:
    try:
        with urllib.request.urlopen(url, timeout=3) as r:  # short: unknown cid must fail fast
            return r.read()
    except Exception:
        return None


def _fetch_blob_from_peers(cid: str, q: dict):
    """Decentralized file fetch: ask each known peer for this content hash.

    Verifies sha256(bytes) == cid before caching — a lying peer cannot poison
    our store because the address IS the hash.
    """
    name = q.get("name", [""])[0]
    for url in peer_urls():
        data = _http_raw(f"{url}/blob/{cid}?name={quote(name)}")
        if data and core.cid_of(data) == cid:
            store.put_blob(data)
            return data
    return None


# ---------------------------------------------------------------------------
# Sync (module-level so mDNS discovery can call it without a request ctx)
# ---------------------------------------------------------------------------
_sync_lock = __import__("threading").Lock()


def sync_all() -> int:
    """Pull everything from known peers; returns #records *newly added*.

    put_record() is keyed by the protocol id (re-adding an existing record
    is a no-op), so we snapshot local ids first and count by set difference
    — the return value is NOT "records fetched".
    """
    if not _sync_lock.acquire(blocking=False):
        return 0  # a sync is already running; don't pile up
    try:
        added = 0
        peers = load_peers()
        for url in list(peers.keys()):
            try:
                recs = http_json(url + "/api/since?ts=0")
            except Exception as e:
                sys.stderr.write(f"[{core.PEER_ID}] peer {url} "
                                 f"unreachable: {e}\n")
                continue
            peers[url]["last_seen"] = int(time.time())
            save_peers(peers)
            known = {r["id"] for r in store.all_records()}
            new_ids = set()
            for rec in recs:
                cid = rec.get("id")
                if not cid or cid in known:
                    continue
                try:
                    assert core.verify(rec), "bad sig"
                    store.put_record(rec)
                    new_ids.add(cid)
                except Exception as e:
                    sys.stderr.write(f"[{core.PEER_ID}] rejected "
                                     f"record {cid}: {e}\n")
            known |= new_ids
            added += len(new_ids)
        return added
    finally:
        _sync_lock.release()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quieter logs
        sys.stderr.write("[%s] %s\n" % (core.PEER_ID, fmt % args))

    # ---- helpers ----------------------------------------------------------
    def _send(self, code: int, body: bytes, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, core.canon(obj))

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(n)

    # ---- routes -----------------------------------------------------------
    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        p = u.path.rstrip("/") or "/"

        if p == "/api/whoami":
            return self._json({"peer": core.PEER_ID, "port": core.PORT})
        if p.startswith("/blob/"):
            cid = p.split("/")[2]
            data = store.get_blob(cid) or _fetch_blob_from_peers(cid, q)
            if data is None:
                return self._json({"error": "not found"}, 404)
            mime = self._guess_mime(q.get("name", [""])[0], data)
            return self._send(200, data, mime)
        if p.startswith("/api/record/"):
            cid = p.split("/")[3]
            rec = store.get_record(cid) or _fetch_from_peers(cid)
            return self._json(rec if rec else {"error": "not found"},
                              200 if rec else 404)
        if p == "/api/index":
            idx = [{"id": r["id"], "type": r["type"], "author": r["author"],
                    "ts": r["ts"]} for r in store.all_records()]
            return self._json(idx)
        if p == "/api/since":
            since = int(q.get("ts", ["0"])[0])
            recs = [r for r in store.all_records() if r["ts"] >= since]
            return self._json(recs)
        if p == "/api/users":
            return self._json(self._profiles())
        if p == "/api/wall":
            return self._json(self._wall())
        if p == "/api/contacts":
            me = q.get("user", [""])[0]
            out = []
            for r in store.all_records():
                if r["type"] == "contact" and r["author"] == me:
                    out.append({"added": r["payload"]["add"], "ts": r["ts"]})
            return self._json(out)
        if p == "/api/dm":
            me, other = q.get("me", [""])[0], q.get("other", [""])[0]
            msgs = []
            for r in store.all_records():
                if r["type"] != "message":
                    continue
                pl = r["payload"]
                if ("to" in pl and
                        {me, other} == {r["author"], pl["to"]}):
                    msgs.append({"from": r["author"], "to": pl["to"],
                                 "text": pl.get("text", ""), "ts": r["ts"],
                                 "id": r["id"]})
            msgs.sort(key=lambda m: m["ts"])
            return self._json(msgs)
        if p == "/api/peers":
            return self._json([{"url": u, **meta}
                               for u, meta in load_peers().items()])
        if p == "/api/discovery":
            return self._json({"mdns_type": MDNS_TYPE, "zeroconf": HAS_ZEROCONF,
                               "enabled": MDNS_ENABLED, **_mdns_state})
        if p == "/api/profile":
            uid = q.get("user", [""])[0]
            prof = self._profiles().get(uid)
            if not prof:  # maybe we know the record id but not the profile yet
                pass
            return self._json(prof or {"error": "unknown user"},
                              200 if prof else 404)
        if p.startswith("/api/"):
            return self._json({"error": "no such api"}, 404)
        return self._static(p)

    def do_POST(self):
        p = urlparse(self.path).path.rstrip("/")

        if p == "/api/blob":
            data = self._body()
            if len(data) > 200 * 1024 * 1024:
                return self._json({"error": "too large (alpha limit 200MB)"},
                                  413)
            return self._json({"cid": store.put_blob(data)})

        if p == "/api/record":
            try:
                rec = json.loads(self._body())
                assert core.verify(rec), "bad signature"
                prev = rec.get("prev")
                if prev and not (store.has_record(prev)
                                 or _fetch_from_peers(prev)):
                    return self._json({"error": "unknown prev record"}, 400)
                # fork guard: reject a second record claiming the same parent
                for r in store.all_records():
                    if (r["author"] == rec["author"] and r["id"] != rec["id"]
                            and r.get("prev") == prev):
                        return self._json(
                            {"error": "chain conflict: another record shares "
                                      "this parent. Sync peers, then rebuild "
                                      "your last record."}, 409)
                rid = store.put_record(rec)
                return self._json({"id": rid})
            except Exception as e:
                return self._json({"error": str(e)}, 400)

        if p == "/api/contact":
            # Add-a-contact-by-key helper: node builds & signs a contact
            # record on behalf of a dev-mode author (real per-user signing
            # stays client-side; this endpoint exists so curl / tests /
            # non-browser clients can add contacts by full key id).
            try:
                j = json.loads(self._body())
                author, add = j["author"], j["add"]
                if not add.startswith("ed25519:") or len(add) < 20:
                    return self._json({"error": "'add' must be a full "
                                                "user key id (ed25519:...)"},
                                      400)
                secret = j.get("secret", core.DEV_SECRET)
                if not core.REAL_KEYS and not str(author).startswith("dev:"):
                    # dev mode: author id is derived from the shared secret
                    pass
                prev = store.head_of(author)
                rec = core.make_record("contact", author, prev,
                                       {"add": add}, secret=secret)
                rid = store.put_record(rec)
                return self._json({"id": rid})
            except Exception as e:
                return self._json({"error": str(e)}, 400)

        if p == "/api/peers":
            url = json.loads(self._body())["url"].rstrip("/")
            if url.endswith(f":{core.PORT}") and core.is_local(url):
                return self._json({"error": "that's this node itself"}, 400)
            peers = add_peer(url)
            n = sync_all()
            return self._json({"peers": list(peers.keys()), "synced": n})

        if p == "/api/sync":
            return self._json({"synced": sync_all()})

        return self._json({"error": "no such endpoint"}, 404)

    # ---- app logic --------------------------------------------------------
    def _profiles(self) -> dict:
        """Latest profile payload per author."""
        prof = {}
        for r in sorted(store.all_records(), key=lambda r: r["ts"]):
            if r["type"] == "profile":
                prof[r["author"]] = r["payload"]
        return prof

    def _wall(self) -> list:
        prof = self._profiles()
        posts = [r for r in store.all_records() if r["type"] == "post"]
        posts.sort(key=lambda r: r["ts"], reverse=True)
        return [{
            "id": r["id"], "ts": r["ts"], "author": r["author"],
            "name": prof.get(r["author"], {}).get("name", r["author"][:8]),
            "text": r["payload"].get("text", ""),
            "media": r["payload"].get("media", []),
        } for r in posts]

    def _guess_mime(self, name: str, data: bytes) -> str:
        low = name.lower()
        for ext, mime in ((".png", "image/png"), (".jpg", "image/jpeg"),
                          (".jpeg", "image/jpeg"), (".gif", "image/gif"),
                          (".webp", "image/webp"), (".mp4", "video/mp4"),
                          (".webm", "video/webm"), (".json", "application/json")):
            if low.endswith(ext):
                return mime
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return "image/png"
        if data[:3] == b"\xff\xd8\xff":
            return "image/jpeg"
        return "application/octet-stream"

    def _static(self, path: str):
        if path == "/":
            path = "/index.html"
        fp = os.path.normpath(os.path.join(WEB_DIR, path.lstrip("/")))
        if not fp.startswith(WEB_DIR) or not os.path.isfile(fp):
            return self._send(404, b"not found", "text/plain")
        with open(fp, "rb") as f:
            data = f.read()
        mime = {".html": "text/html", ".js": "text/javascript",
                ".css": "text/css"}.get(os.path.splitext(fp)[1],
                                        "application/octet-stream")
        self._send(200, data, mime)


class Server(ThreadingMixIn, ThreadingHTTPServer):
    daemon_threads = True  # don't hang shutdown on stuck peer fetches


def main():
    mdns_start()
    srv = Server(("0.0.0.0", core.PORT), Handler)
    disc = ("mDNS on" if (_mdns_state.get("announced")) else
            f"mDNS off ({_mdns_state.get('error') or 'disabled'})")
    print(f"[{core.PEER_ID}] MeshWall node on http://localhost:{core.PORT} "
          f"(data: {os.path.abspath(core.DATA_DIR)}, "
          f"keys: {'ed25519' if core.REAL_KEYS else 'dev'}, {disc})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        mdns_stop()


if __name__ == "__main__":
    main()
