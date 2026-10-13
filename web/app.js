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
let me = null; // {id, name, privKey (CryptoKey)}

async function loadIdentity() {
  const raw = localStorage.getItem("mw_identity");
  if (!raw) return;
  const s = JSON.parse(raw);
  try {
    const privKey = await crypto.subtle.importKey("pkcs8",
      unb64(s.pkcs8), { name: "Ed25519" }, false, ["sign"]);
    me = { id: s.id, name: s.name, privKey };
  } catch (e) { console.warn("bad stored identity", e); }
}

async function register(name) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true,
    ["sign", "verify"]);
  const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
  // raw 32-byte pubkey = last 32 bytes of SPKI
  const rawPub = new Uint8Array(spki).slice(-32);
  const pkcs8 = b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  me = { id: "ed25519:" + b64(rawPub), name, privKey: kp.privateKey };
  localStorage.setItem("mw_identity",
    JSON.stringify({ id: me.id, name, pkcs8 }));
  // genesis record: profile
  await postRecord("profile", { name });
  refreshAll();
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

async function myHead() {
  const idx = await api("/api/index");
  const mine = idx.filter(r => r.author === me.id)
                  .sort((a, b) => b.ts - a.ts);
  return mine.length ? mine[0].id : null;
}

async function postRecord(type, payload) {
  const body = { type, author: me.id, prev: await myHead(),
                 ts: Math.floor(Date.now() / 1000), payload };
  body.sig = await signBody(body);            // signs body WITHOUT sig/id
  body.id = await deriveId(body);             // id hashes body+sig
  return api("/api/record", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body) });
}

// ---------- views -----------------------------------------------------------
async function renderWall() {
  const posts = await api("/api/wall");
  $("#wall").innerHTML = posts.map(p => `
    <div class="post">
      <div class="meta">${esc(p.name)} · ${short(p.author)} ·
        ${new Date(p.ts * 1000).toLocaleString()} ·
        <span title="${esc(p.id)}">cid:${short(p.id)}</span></div>
      <div>${esc(p.text)}</div>
      ${(p.media || []).map(m => m.mime?.startsWith("video/")
        ? `<video src="/blob/${m.cid}?name=${m.mime}" controls></video>`
        : `<img src="/blob/${m.cid}?name=${m.mime}" loading="lazy">`).join("")}
    </div>`).join("") || `<p class="dim">Empty wall. Post something!</p>`;
}

async function renderContacts() {
  const [users, contacts] = await Promise.all([
    api("/api/users"),
    me ? api("/api/contacts?user=" + encodeURIComponent(me.id)) : []]);
  const added = new Set((contacts || []).map(c => c.added));
  $("#directory").innerHTML = Object.entries(users).map(([id, p]) => `
    <div class="post"><b>${esc(p.name)}</b> <code class="dim small">${short(id)}</code>
    ${me && id !== me.id && !added.has(id)
      ? `<button onclick="addContact('${esc(id)}')">＋ contact</button>` : ""}
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
  refreshAll();
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

async function renderPeers() {
  const [who, peers] = await Promise.all([api("/api/whoami"), api("/api/peers")]);
  $("#node-info").textContent =
    `peer "${who.peer}" on port ${who.port} — serves & replicates blobs/records`;
  $("#peerlist").innerHTML = peers.map(p => `<li><code>${esc(p)}</code></li>`)
    .join("") || `<li class="dim">none — add another node's URL</li>`;
}

async function refreshAll() {
  $("#btn-register").disabled = !!me;
  $("#id-none").hidden = !!me;
  $("#id-you").hidden = !me;
  if (me) { $("#you-name").textContent = me.name;
            $("#you-id").textContent = me.id.slice(0, 27) + "…"; }
  try {
    await Promise.all([renderWall(), renderContacts(), renderChat(), renderPeers()]);
  } catch (e) { console.error(e); }
}

// ---------- wiring ----------------------------------------------------------
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
  if (!me) return alert("create an identity first");
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
  refreshAll();
};

$("#chat-form").onsubmit = async (e) => {
  e.preventDefault();
  if (!me) return alert("create an identity first");
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
  const url = $("#peer-url").value.trim();
  if (!url) return;
  await api("/api/peers", { method: "POST", body: JSON.stringify({ url }) });
  $("#peer-url").value = "";
  doSync();
};

$("#btn-sync").onclick = doSync;
async function doSync() {
  const btn = $("#btn-sync");
  btn.textContent = "⟳ syncing…";
  try {
    const { synced } = await api("/api/sync", { method: "POST" });
    btn.textContent = `⟳ sync (${synced} new)`;
    await refreshAll();
  } catch (e) { btn.textContent = "⟳ sync failed"; console.error(e); }
  setTimeout(() => (btn.textContent = "⟳ Sync peers"), 2500);
}

// poll lightly so two browsers see each other's posts without manual sync
setInterval(() => { if (me) refreshAll(); }, 5000);

loadIdentity().then(refreshAll);
api("/api/whoami").then(w => $("#whoami").textContent = `node: ${w.peer}:${w.port}`);
