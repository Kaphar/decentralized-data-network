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
#  GET  /api/peers                   -> known peers
#  POST /api/sync                    -> pull records from all known peers
#  GET  /*                           -> static files from ./web (the SPA)

import json
import os
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, quote

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from mw import core  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB_DIR = os.path.join(ROOT, "web")

store = core.Store(core.DATA_DIR)
PEERS_FILE = os.path.join(core.DATA_DIR, "peers.json")


def load_peers() -> list:
    try:
        with open(PEERS_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        return []


def save_peers(peers: list):
    with open(PEERS_FILE, "w") as f:
        json.dump(peers, f)


def http_json(url: str, data=None, headers=None) -> dict:
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())


def _fetch_from_peers(cid: str):
    """Look up a record by CID from known peers; cache it locally if valid."""
    for url in load_peers():
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
    for url in load_peers():
        data = _http_raw(f"{url}/blob/{cid}?name={quote(name)}")
        if data and core.cid_of(data) == cid:
            store.put_blob(data)
            return data
    return None


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
            return self._json(load_peers())
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
                if prev and not (store.get_record(prev)
                                 or _fetch_from_peers(prev)):
                    return self._json({"error": "unknown prev record"}, 400)
                rid = store.put_record(rec)
                return self._json({"id": rid})
            except Exception as e:
                return self._json({"error": str(e)}, 400)

        if p == "/api/peers":
            url = json.loads(self._body())["url"].rstrip("/")
            peers = load_peers()
            if url not in peers:
                peers.append(url)
                save_peers(peers)
            return self._json({"peers": peers})

        if p == "/api/sync":
            return self._json({"synced": self._sync_from_peers()})

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

    def _sync_from_peers(self) -> int:
        """Pull everything from known peers; returns #records *newly added*.

        Note: put_record() is content-addressed (re-adding an existing record
        is a no-op), so we must snapshot local ids first and count by set
        difference — the return value is NOT "records fetched".
        """
        added = 0
        for url in load_peers():
            try:
                recs = http_json(url + "/api/since?ts=0")
            except Exception as e:
                self.log_message("peer %s unreachable: %s", url, e)
                continue
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
                    self.log_message("rejected record %s: %s", cid, e)
            known |= new_ids
            added += len(new_ids)
        return added

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


def main():
    srv = ThreadingHTTPServer(("0.0.0.0", core.PORT), Handler)
    print(f"[{core.PEER_ID}] MeshWall node on http://localhost:{core.PORT} "
          f"(data: {os.path.abspath(core.DATA_DIR)}, "
          f"keys: {'ed25519' if core.REAL_KEYS else 'dev'})")
    srv.serve_forever()


if __name__ == "__main__":
    main()
