# MeshWall alpha — end-to-end smoke test (stdlib only).
# Boots two nodes as subprocesses, then exercises:
#   blob upload -> signed record chains (profile/contact/post/message) ->
#   tamper rejection -> peer sync -> cross-node decentralized blob fetch.
# Run:  python tests/smoke_test.py

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from mw import core  # noqa: E402

A_PORT, B_PORT = 4181, 4182
A_URL, B_URL = f"http://127.0.0.1:{A_PORT}", f"http://127.0.0.1:{B_PORT}"


def req(url, data=None, raw=False):
    """raw=True: send/receive bytes as-is (blob API). Otherwise JSON."""
    if raw:
        body = data                      # bytes or None
        r = urllib.request.urlopen(urllib.request.Request(url, data=body),
                                   timeout=5)
        return r.read()
    body = core.canon(data) if data is not None else None
    r = urllib.request.urlopen(urllib.request.Request(url, data=body), timeout=5)
    return json.loads(r.read())


def wait_up(url, tries=40):
    for _ in range(tries):
        try:
            req(url + "/api/whoami")
            return
        except Exception:
            time.sleep(0.25)
    raise RuntimeError("node did not start: " + url)


def post(url, type_, author, prev, payload):
    """Build a signed record client-side and submit it, like the browser does."""
    rec = core.make_record(type_, author, prev, payload)
    return req(url + "/api/record", rec)["id"]


def main():
    for d in ("data/tA", "data/tB"):
        shutil.rmtree(os.path.join(ROOT, d), ignore_errors=True)

    env_a = dict(os.environ, MW_PEER_ID="alice", MW_PORT=str(A_PORT),
                 MW_DATA=os.path.join(ROOT, "data/tA"))
    env_b = dict(os.environ, MW_PEER_ID="bob", MW_PORT=str(B_PORT),
                 MW_DATA=os.path.join(ROOT, "data/tB"))
    procs = [subprocess.Popen([sys.executable, "-m", "mw.node"], cwd=ROOT, env=env_a),
             subprocess.Popen([sys.executable, "-m", "mw.node"], cwd=ROOT, env=env_b)]
    try:
        wait_up(A_URL); wait_up(B_URL)

        # --- Alice creates identity + posts text & an image -----------------
        alice = "did:dev:alice"
        img = b"\x89PNG\r\n\x1a\nfake-test-image-bytes"
        cid = json.loads(req(A_URL + "/api/blob", img, raw=True))["cid"]
        assert core.cid_of(img) == cid

        h1 = post(A_URL, "profile", alice, None, {"name": "Alice"})
        h2 = post(A_URL, "post", alice, h1,
                  {"text": "hello mesh", "media": [{"cid": cid,
                                                    "mime": "image/png"}]})
        print("ok: profile+post accepted, cids:", h1[:8], h2[:8])

        # --- Bob adds contact + DM ------------------------------------------
        bob = "did:dev:bob"
        b1 = post(B_URL, "profile", bob, None, {"name": "Bob"})
        b2 = post(B_URL, "contact", bob, b1, {"add": alice})
        post(B_URL, "message", bob, b2, {"to": alice, "text": "hi alice"})
        print("ok: bob chain built")

        # --- tampering must be rejected --------------------------------------
        bad = core.make_record("post", alice, h2, {"text": "forged"})
        bad["payload"]["text"] = "tampered!"          # invalidate signature
        try:
            req(A_URL + "/api/record", bad)
            raise AssertionError("tampered record was accepted!")
        except urllib.error.HTTPError as e:
            assert e.code == 400, e.code
        print("ok: tampered record rejected (400)")

        # --- link peers and sync both ways -----------------------------------
        req(A_URL + "/api/peers", {"url": B_URL})
        req(B_URL + "/api/peers", {"url": A_URL})
        n_a = req(A_URL + "/api/sync", {})["synced"]
        n_b = req(B_URL + "/api/sync", {})["synced"]
        assert n_a == 3 and n_b == 2, (n_a, n_b)
        print(f"ok: synced {n_a} -> alice, {n_b} -> bob")

        # --- wall now visible on both nodes ----------------------------------
        wall_a = req(A_URL + "/api/wall")
        wall_b = req(B_URL + "/api/wall")
        assert len(wall_a) == len(wall_b) == 1
        assert wall_a[0]["name"] == "Alice"
        print("ok: identical walls on both nodes:", wall_a[0]["text"])

        # --- DM thread resolves from either node ------------------------------
        dm = req(B_URL + f"/api/dm?me={alice}&other={bob}")
        assert dm[0]["text"] == "hi alice"
        print("ok: DM readable from bob's node")

        # --- THE key demo: blob lives ONLY on Alice; Bob must fetch it through
        # the mesh. (sync only replicates records; blobs are pulled by CID.)
        blobpath = os.path.join(ROOT, "data/tB/blobs", cid)
        assert not os.path.exists(blobpath), "bob should not have the blob yet"
        got = req(B_URL + f"/blob/{cid}?name=x.png", raw=True)  # bob pulls from alice
        assert got == img
        assert os.path.exists(blobpath), "should have re-cached on bob"
        print("ok: decentralized blob fetch via peer (sha256-verified + cached)")

        # --- unknown cid still 404s everywhere --------------------------------
        try:
            req(A_URL + "/blob/" + "0" * 64, raw=True)
            raise AssertionError("bogus cid served?!")
        except urllib.error.HTTPError as e:
            assert e.code == 404
        print("ok: content-addressing enforced (bogus cid -> 404)")

    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            p.wait(timeout=5)
    print("\nALL SMOKE TESTS PASSED \u2714")
    for d in ("data/tA", "data/tB"):
        shutil.rmtree(os.path.join(ROOT, d), ignore_errors=True)


if __name__ == "__main__":
    main()
