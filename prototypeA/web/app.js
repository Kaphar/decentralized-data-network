// MeshWall alpha frontend — vanilla JS, no build step.
//
// Identity model (alpha): Ed25519 keypair generated in the browser via
// WebCrypto; user id = "ed25519:<base64 raw public key>". The private key
// lives in localStorage (NO backup/export yet — wipe = lose identity).
// Records are hash-linked per author (prev = id of your last record),
// signed by you, and stored/served by whatever node(s) you talk to.

const API = "";            // same-origin: this page is served by a local node

// ---------- tiny helpers ---------------------------------------------------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const short = (id) => (id || "?").slice(7, 15);   // strip "ed25519:" prefix

async function sha256hex(bytes) {
  const h = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}
// Deterministic JSON: sorted keys, no whitespace — byte-compatible with
// python json.dumps(obj, sort_keys=True, separators=(",", ":")) for the
// ASCII-only payloads we produce.
function canonicalJSON(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJSON).join(",") + "]";
  return "{" + Object.keys(v).sort()
    .map(k => JSON.stringify(k) + ":" + canonicalJSON(v[k])).join(",") + "}";
}

// ---------- identity -------------------------------------------------------
// Multiple identities stored in localStorage under "mw_identities":
//   { <id>: { id, name, pkcs8 } }
// Active identity tracked via "mw_active_identity" key.
let me = null; // {id, name, privKey (CryptoKey)}


async function listIdentities() {
  try {
    const raw = localStorage.getItem("mw_identities");
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveIdentities(idMap) {
  localStorage.setItem("mw_identities", JSON.stringify(idMap));
}

function setActiveIdentity(id) {
  localStorage.setItem("mw_active_identity", id);
}

function getActiveIdentityId() {
  return localStorage.getItem("mw_active_identity");
}

async function removeIdentity(id) {
  const idMap = await listIdentities();
  delete idMap[id];
  saveIdentities(idMap);
  const active = getActiveIdentityId();
  if (active === id) {
    localStorage.removeItem("mw_active_identity");
    me = null;
    chainCacheKey = "mw_chain";
  }
  return idMap;
}

async function switchIdentity(id) {
  const idMap = await listIdentities();
  const entry = idMap[id];
  if (!entry) { toast("identity not found", true); return false; }
  try {
    const privKey = await crypto.subtle.importKey(
      "pkcs8", unb64(entry.pkcs8), { name: "Ed25519" }, false, ["sign"]);
    me = { id: entry.id, name: entry.name, privKey };
    chainCacheKey = "mw_chain_" + me.id;
    setActiveIdentity(me.id);
    refreshAll();
    return true;
  } catch (e) {
    toast("❌ failed to switch identity: " + (e.message || e), true);
    return false;
  }
}

function showIdentitySwitcher() {
  listIdentities().then(idMap => {
    const entries = Object.values(idMap);
    if (entries.length <= 1) {
      toast("Only one identity stored. Create another first.", true);
      return;
    }
    const active = getActiveIdentityId();
    const items = entries.map(e => {
      const isActive = e.id === active;
      return `<div style="padding:0.3rem 0">
        <span style="color:${isActive ? 'var(--acc)' : 'inherit'}">
          ${isActive ? '● ' : '○ '}${esc(e.name)}</span>
        <code class="dim small">${short(e.id)}</code>
        <button class="ghost" style="margin-left:0.4rem"
          onclick="_switchIdentity('${e.id}')">switch</button>
        ${!isActive ? `<button class="ghost"
          onclick="_removeIdentity('${e.id}')">remove</button>` : ""}
      </div>`;
    }).join("");
    const modal = document.createElement("div");
    modal.id = "identity-switcher";
    modal.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;" +
      "background:rgba(0,0,0,.7);z-index:100;display:flex;align-items:center;" +
      "justify-content:center";
    modal.innerHTML = `
      <div style="background:var(--card);padding:1.5rem;border-radius:12px;max-width:340px">
        <h3 style="margin:0 0 .8rem">Identities</h3>
        ${items}
        <hr style="border-color:#333">
        <button onclick="document.getElementById('identity-switcher').remove()" class="ghost">Close</button>
      </div>`;
    document.body.appendChild(modal);
  });
}

window._switchIdentity = async (id) => {
  const ok = await switchIdentity(id);
  if (ok) {
    document.getElementById("identity-switcher")?.remove();
    toast("✓ switched to " + (me?.name || "identity"));
  }
};

window._removeIdentity = async (id) => {
  await removeIdentity(id);
  document.getElementById("identity-switcher")?.remove();
  loadIdentity().then(refreshAll);
  toast("✓ removed identity");
};

function switchToIdentity(id) {
  switchIdentity(id);
}
window.switchToIdentity = switchToIdentity;

// tiny toast so silent failures become visible (the alpha's #1 debugging win)
function toast(msg, isError) {
  let t = document.createElement("div");
  t.className = "toast" + (isError ? " err" : "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => { t.classList.remove("show");
                     setTimeout(() => t.remove(), 300); }, 4200);
}

async function loadIdentity() {
  const activeId = getActiveIdentityId();
  if (!activeId) return;
  const idMap = await listIdentities();
  const s = idMap[activeId];
  if (!s) return;
  try {
    const privKey = await crypto.subtle.importKey("pkcs8",
      unb64(s.pkcs8), { name: "Ed25519" }, false, ["sign"]);
    me = { id: s.id, name: s.name, privKey };
    chainCacheKey = "mw_chain_" + s.id;
  } catch (e) { console.warn("bad stored identity", e); }
}

async function register(name) {
  if (typeof crypto === "undefined" || !crypto.subtle ||
      location.protocol !== "https:" &&
      location.hostname !== "localhost" &&
      location.hostname !== "127.0.0.1" &&
      location.hostname !== "::1") {
    toast("HTTPS required on mobile Chrome. Start your node with MW_TLS=1 then " +
          "open https://" + location.host + " (self-signed, click through)", true);
    return;
  }
  try {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true,
      ["sign", "verify"]);
    const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
    // raw 32-byte pubkey = last 32 bytes of SPKI
    const rawPub = new Uint8Array(spki).slice(-32);
    const pkcs8 = b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
    me = { id: "ed25519:" + b64(rawPub), name, privKey: kp.privateKey };
    chainCacheKey = "mw_chain_" + me.id;
    // Store in multi-identity map
    const idMap = await listIdentities();
    idMap[me.id] = { id: me.id, name, pkcs8 };
    saveIdentities(idMap);
    setActiveIdentity(me.id);
    // genesis record: profile
    await postRecord("profile", { name });
    refreshAll();
  } catch (e) {
    toast("❌ failed to create identity: " + (e.message || e), true);
    console.error(e);
  }
}

async function signBody(body) {
  const sig = await crypto.subtle.sign("Ed25519", me.privKey,
    new TextEncoder().encode(canonicalJSON(body)));
  return b64(new Uint8Array(sig));
}

// canonical JSON of body+sig (for deriving the record id) — mirrors python:
// sha256hex(canon({**body_without_id, "sig": sig}))
async function deriveId(bodyWithSig) {
  const { id, ...rest } = bodyWithSig;   // id must not be part of its own hash
  return sha256hex(new TextEncoder().encode(canonicalJSON(rest)));
}

// ---------- record building / posting -------------------------------------
// Protocol contract (shared with mw/core.py):
//   body        = {type, author, prev, ts, payload}      (canonical JSON)
//   sig         = Ed25519 signature over canonical(body), base64
//   id          = sha256hex( canonical({...body, sig}) )  -> the record's CID
// The node re-derives everything and rejects mismatches, so browser & Python
// must agree byte-for-byte on canonical JSON encoding.

async function api(path, opts = {}) {
  const r = await fetch(API + path, opts);
  if (!r.ok) throw new Error((await r.text()).slice(0, 200) || r.status);
  return r.json();
}

// Head of MY chain = newest record I authored, known to ANY peer we've ever
// synced with. We keep a durable local cache of my full chain (localStorage)
// so this survives switching nodes, wiping node data, or clearing caches —
// losing track of `prev` would otherwise fork the chain and every later
// post would be rejected ("unknown prev record") => nothing appears on wall.
let chainCacheKey = "mw_chain";   // rebound to per-identity key in loadIdentity/register

function loadChainCache() {
  try { return JSON.parse(localStorage.getItem(chainCacheKey)) || []; }
  catch { return []; }
}
function saveChainCache(recs) { localStorage.setItem(chainCacheKey, JSON.stringify(recs)); }
function rememberMyRecord(body) {
  const recs = loadChainCache();
  if (!recs.some(r => r.id === body.id)) recs.push(body);
  saveChainCache(recs);
}

async function myHead() {
  let best = null;
  const consider = (r) => {
    if (r.author !== me.id) return;
    if (!best || r.ts > best.ts || (r.ts === best.ts && r.id > best.id)) best = r;
  };
  // 1) local chain cache (authoritative for our own history)
  loadChainCache().forEach(consider);
  // 2) whatever the current node + its peers know
  try {
    const idx = await api("/api/index");
    idx.forEach(consider);
  } catch (e) { console.warn("index read failed", e); }
  return best ? best.id : null;
}

async function postRecord(type, payload) {
  const body = { type, author: me.id, prev: await myHead(),
                 ts: Math.floor(Date.now() / 1000), payload };
  body.sig = await signBody(body);            // signs body WITHOUT sig/id
  body.id = await deriveId(body);             // id hashes body+sig
  try {
    const res = await api("/api/record", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body) });
    rememberMyRecord(body);
    return res;
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.includes("chain conflict") || msg.includes("unknown prev")) {
      // Our cached head is stale (we were offline while another tab/node
      // extended the chain, or the identity was created on a different node).
      // Refresh from the network, retry once.
      try { await doSync(); } catch {}
      const newPrev = await myHead();
      const oldPrev = body.prev;
      if (newPrev === oldPrev) {
        // Sync didn't bring in anything new - the prev record genuinely
        // doesn't exist on this node. Start a fresh chain (genesis).
        body.prev = null;
      } else {
        body.prev = newPrev;
      }
      delete body.sig; delete body.id;
      body.ts = Math.floor(Date.now() / 1000);
      body.sig = await signBody(body);
      body.id = await deriveId(body);
      const res = await api("/api/record", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body) });
      rememberMyRecord(body);
      toast(body.prev === null
        ? "⟲ retried with fresh chain"
        : "⟲ retried after chain resync");
      return res;
    }
    toast("❌ " + msg, true);
    throw e;
  }
}

// ---------- views -----------------------------------------------------------
let lastWallHash = null;
let lastUsersHash = null;
let lastPeersHash = null;

// Incremental wall render: preserves existing DOM nodes (video elements
// stay alive) by only adding/removing/reordering as needed.
function renderWallCache(posts) {
  const wall = $("#wall");
  // Collect existing posts by id
  const existing = {};
  wall.querySelectorAll(".post").forEach(el => {
    const id = el.dataset.cid;
    if (id) existing[id] = el;
  });
  // Build new DOM (reuse existing elements where possible)
  const frag = document.createDocumentFragment();
  if (posts.length === 0) {
    wall.innerHTML = `<p class="dim">Empty wall. Post something!</p>`;
    return;
  }
  posts.forEach(p => {
    const existingEl = existing[p.id];
    if (existingEl) {
      // Reuse this element (preserves video playback state)
      frag.appendChild(existingEl);
    } else {
      // Create new element
      const div = document.createElement("div");
      div.className = "post";
      div.dataset.cid = p.id;
      div.innerHTML = `
        <div class="meta">${esc(p.name)} · ${short(p.author)} ·
          ${new Date(p.ts * 1000).toLocaleString()} ·
          <span title="${esc(p.id)}">cid:${short(p.id)}</span></div>
        <div>${esc(p.text)}</div>
        ${(p.media || []).map(m => {
          if (m.mime?.startsWith("video/")) {
            return `<video src="/blob/${m.cid}?name=${m.mime}"
              controls preload="metadata"></video>`;
          }
          return `<img src="/blob/${m.cid}?name=${m.mime}" loading="lazy">`;
        }).join("")}`;
      frag.appendChild(div);
    }
  });
  // Replace wall content in one operation
  while (wall.firstChild) wall.removeChild(wall.firstChild);
  wall.appendChild(frag);
}

function renderContactsCache(users, contacts) {
  const added = new Set((contacts || []).map(c => c.added));
  $("#directory").innerHTML = Object.entries(users).map(([id, p]) => `
    <div class="post"><b>${esc(p.name)}</b> <code class="dim small">${short(id)}</code>
    ${me && id !== me.id && !added.has(id)
      ? `<button onclick="addContact('${esc(id)}')">＋ contact</button>` : ""}
      <button class="ghost" onclick="copyKey('${esc(id)}')" title="copy full key id">⧉ key</button>
    </div>`).join("") || `<p class="dim">Nobody yet. Sync with peers first.</p>`;
  $("#contacts").innerHTML = (contacts || []).map(c =>
    `<li>${esc(users[c.added]?.name || short(c.added))}
       <code class="dim small">${short(c.added)}</code></li>`).join("")
    || `<li class="dim">no contacts yet</li>`;
  const sel = $("#chat-peer");
  sel.innerHTML = (contacts || []).map(c => {
    const u = users[c.added];
    return `<option value="${esc(c.added)}">${esc(u?.name || short(c.added))}</option>`;
  }).join("");
}

window.addContact = async (userId) => {
  await postRecord("contact", { add: userId });
  toast("✓ contact added");
  refreshAll();
};

// Add a contact by pasting their FULL key id (ed25519:...). Works even when
// their profile hasn't synced to this node yet — the contact record only
// needs the key; the name fills in as soon as we learn it from any peer.
$("#btn-add-key").onclick = async () => {
  if (!me) return toast("create an identity first", true);
  let key = $("#add-key").value.trim();
  // tolerate bare base64 pubkey without the "ed25519:" prefix
  if (key && !key.startsWith("ed25519:") && /^[A-Za-z0-9+/=]{40,}$/.test(key))
    key = "ed25519:" + key;
  if (!/^ed25519:[A-Za-z0-9+/=]{30,}$/.test(key))
    return toast("paste a full key id (ed25519:…)", true);
  if (key === me.id) return toast("that's your own key 🙂", true);
  const existing = await api("/api/contacts?user=" + encodeURIComponent(me.id));
  if ((existing || []).some(c => c.added === key))
    return toast("already a contact");
  await postRecord("contact", { add: key });
  $("#add-key").value = "";
  toast("✓ contact added by key");
  refreshAll();
};

window.copyKey = async (id) => {
  try { await navigator.clipboard.writeText(id); toast("⧉ key copied"); }
  catch { prompt("copy manually:", id); }
};

async function renderChat() {
  if (!me) return;
  const other = $("#chat-peer").value;
  if (!other) { $("#thread").innerHTML = `<p class="dim">add a contact first</p>`; return; }
  const msgs = await api(`/api/dm?me=${encodeURIComponent(me.id)}&other=${encodeURIComponent(other)}`);
  const users = await api("/api/users");
  $("#thread").innerHTML = msgs.map(m => `
    <div class="msg ${m.from === me.id ? "me" : ""}">
      <span>${esc(m.text)}</span>
      <span class="t">${esc(users[m.from]?.name || short(m.from))}
        ${new Date(m.ts * 1000).toLocaleTimeString()}</span>
    </div>`).join("") || `<p class="dim">no messages yet</p>`;
  $("#thread").scrollTop = $("#thread").scrollHeight;
}

function renderPeersCache(peers, disc, who) {
  $("#node-info").textContent =
    `peer "${who.peer}" on port ${who.port} — serves & replicates blobs/records`;
  $("#peerlist").innerHTML = peers.map(p => `<li><code>${esc(p.url)}</code>` +
    (p.discovered ? ` <span class="tag">auto-discovered</span>` : "") +
    (p.last_seen ? ` <span class="dim small">seen ${new Date(p.last_seen * 1000).toLocaleTimeString()}</span>` : "") +
    `</li>`).join("") || `<li class="dim">none yet</li>`;
  const el = $("#disc-status");
  if (el) el.innerHTML = disc.announced
    ? `<span class="ok">● mDNS active</span> — announcing <code>${esc(disc.mdns_type)}</code>; LAN nodes find each other automatically and sync.`
    : `<span class="warn">○ mDNS off</span> — ${esc(disc.error || "disabled")}. ` +
      `Run <code>pip install zeroconf</code> before starting the nodes to enable automatic LAN discovery.`;
}

// background auto-sync: cheap, keeps two open browsers converging without
// clicking Sync (the 5s poll below only re-reads THIS node's data)
setInterval(() => { if (me) doSync(true); }, 8000);

async function refreshAll() {
  $("#btn-register").disabled = !!me;
  $("#id-none").hidden = !!me;
  $("#id-you").hidden = !me;
  if (me) { $("#you-name").textContent = me.name;
             const el = $("#you-id");
             el.textContent = me.id.slice(0, 27) + "…";
             el.onclick = () => copyKey(me.id); }
  // Wire up identity management buttons
  const mgr = $("#btn-manage-identities");
  if (mgr) mgr.onclick = showIdentitySwitcher;
  const sw = $("#btn-switch-identity");
  if (sw) sw.onclick = showIdentitySwitcher;
  const rm = $("#btn-remove-identity");
  if (rm) rm.onclick = removeCurrentIdentity;
  try {
    // Only re-render if data changed - rebuilding DOM destroys <video>/<img> mid-load
    const [users, wall, peers, disc] = await Promise.all([
      api("/api/users"), api("/api/wall"), api("/api/peers"), api("/api/discovery"),
    ]);
    // Wall - only rebuild if post IDs changed (preserves playing videos)
    const who = await api("/api/whoami");
    const wallHash = JSON.stringify(wall.map(p => p.id));
    if (wallHash !== lastWallHash) {
      lastWallHash = wallHash;
      renderWallCache(wall);
    }
    // Users directory + contacts
    const usersHash = JSON.stringify(users);
    if (usersHash !== lastUsersHash) {
      lastUsersHash = usersHash;
      const contacts = me ? await api("/api/contacts?user=" + encodeURIComponent(me.id)) : [];
      renderContactsCache(users, contacts);
    }
    // Peers + discovery status
    const peersHash = JSON.stringify(peers);
    if (peersHash !== lastPeersHash) {
      lastPeersHash = peersHash;
      renderPeersCache(peers, disc, who);
    }
  } catch (e) { console.error(e); toast("⚠ " + e.message, true); }
}

function switchToIdentity(id) {
  switchIdentity(id);
}
window.switchToIdentity = switchToIdentity;

function removeCurrentIdentity() {
  if (!me) return;
  if (!confirm("Remove identity '" + me.name + "'? This cannot be undone.")) return;
  removeIdentity(me.id).then(() => {
    me = null;
    chainCacheKey = "mw_chain";
    refreshAll();
    // Also clear any cached chain data for this identity
    toast("✓ identity removed");
  });
}
window.removeCurrentIdentity = removeCurrentIdentity;
$("#btn-register").onclick = () => {
  const n = $("#name").value.trim();
  if (n) register(n);
};

$("#tabs").addEventListener("click", (e) => {
  const t = e.target?.dataset?.tab;
  if (!t) return;
  document.querySelectorAll("#tabs button").forEach(b =>
    b.classList.toggle("on", b.dataset.tab === t));
  document.querySelectorAll(".tab").forEach(s => s.hidden = s.id !== "tab-" + t);
});

$("#post-form").onsubmit = async (e) => {
  e.preventDefault();
  if (!me) return toast("create an identity first", true);
  const btn = $("#post-form button[type=submit]");
  btn.disabled = true; btn.textContent = "posting…";
  try {
    const media = [];
    const f = $("#post-file").files[0];
    if (f) {
      const buf = await f.arrayBuffer();
      const { cid } = await api("/api/blob", { method: "POST", body: buf });
      media.push({ cid, mime: f.type || "application/octet-stream" });
    }
    const text = $("#post-text").value.trim();
    if (!text && !media.length) return;
    await postRecord("post", { text, media });
    $("#post-text").value = ""; $("#post-file").value = "";
    toast("✓ posted to wall");
    refreshAll();
  } catch (e) {
    console.error(e);            // postRecord already toasted the reason
  } finally {
    btn.disabled = false; btn.textContent = "Post to wall";
  }
};

$("#chat-form").onsubmit = async (e) => {
  e.preventDefault();
  if (!me) return toast("create an identity first", true);
  const other = $("#chat-peer").value;
  const text = $("#chat-input").value.trim();
  if (!other || !text) return;
  await postRecord("message", { to: other, text });
  $("#chat-input").value = "";
  renderChat();
};

$("#btn-refresh-chat").onclick = renderChat;
$("#chat-peer").onchange = renderChat;

$("#peer-form").onsubmit = async (e) => {
  e.preventDefault();
  let url = $("#peer-url").value.trim();
  if (!url) return;
  const proto = location.protocol;
  if (!/^https?:\/\//.test(url)) url = proto + "//" + url;
  try {
    const res = await api("/api/peers", { method: "POST",
      body: JSON.stringify({ url }) });
    $("#peer-url").value = "";
    toast(`✓ peer added — synced ${res.synced} record(s)`);
    doSync();
  } catch (e) { toast("❌ " + e.message, true); }
};

$("#btn-sync").onclick = () => doSync(false);
async function doSync(quiet) {
  const btn = $("#btn-sync");
  if (!quiet) btn.textContent = "⟳ syncing…";
  try {
    const { synced } = await api("/api/sync", { method: "POST" });
    if (!quiet) btn.textContent = `⟳ sync (${synced} new)`;
    if (synced) await refreshAll();
  } catch (e) {
    if (!quiet) btn.textContent = "⟳ sync failed";
    console.error(e);
  }
  if (!quiet) setTimeout(() => (btn.textContent = "⟳ Sync peers"), 2500);
}

// poll lightly so two browsers see each other's posts without manual sync
setInterval(() => { if (me) refreshAll(); }, 5000);

// warn early if WebCrypto won't work (insecure context on mobile)
if (typeof crypto === "undefined" || !crypto.subtle ||
    (location.protocol !== "https:" &&
     location.hostname !== "localhost" &&
     location.hostname !== "127.0.0.1" &&
     location.hostname !== "::1")) {
  toast("⚠ Identity creation needs HTTPS or localhost. " +
        "This page is served over " + location.protocol + "//" +
        location.host + " — key generation will fail.", true);
}

loadIdentity().then(refreshAll);
api("/api/whoami").then(w => $("#whoami").textContent = `node: ${w.peer}:${w.port}`);
