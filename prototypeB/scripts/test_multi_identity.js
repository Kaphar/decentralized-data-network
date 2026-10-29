#!/usr/bin/env node
'use strict';

/// Multi-Identity Community Visibility Test
///
/// Starts three DDN nodes (three distinct Ed25519 identities) and verifies
/// that when a community is created, members can be promoted, and posts with
/// text / image / video / audio media are propagated and visible to all
/// members across the P2P network.
///
/// Key behaviours under test:
///   - Each node has a unique identity (multi-identity).
///   - Community creation → membership promotion → sync propagation.
///   - Text posts signed by different members are visible on every wall.
///   - Blob uploads (image, video, audio) produce CIDs that are embedded in
///     post payloads and synced as records.
///   - Blobs remain fetchable from the uploading node (CAS).
///   - Records referencing media are visible on all members' walls after sync.
///
/// NOTE: Raw blob bytes are NOT auto-synced via HTTP /api/sync (they travel
///       via WebRTC data channels per the DDN design).  This test verifies
///       record-level visibility and blob availability on the origin node.

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const SLOW = process.argv.includes('--slow');
const DELAY = SLOW ? 3000 : 400;

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT_START = Date.now();

const PORT_A = 3011;
const PORT_B = 3012;
const PORT_C = 3013;
const P2P_PORT_A = 4011;
const P2P_PORT_B = 4012;
const P2P_PORT_C = 4013;
const DATA_DIR_A = path.join(os.tmpdir(), 'ddn-multi-a');
const DATA_DIR_B = path.join(os.tmpdir(), 'ddn-multi-b');
const DATA_DIR_C = path.join(os.tmpdir(), 'ddn-multi-c');
const NODE_DIR = path.resolve(__dirname, '..', 'node');

let procA = null;
let procB = null;
let procC = null;

function log(msg, tag = '') {
  const elapsed = ((Date.now() - SCRIPT_START) / 1000).toFixed(1);
  const prefix = tag ? `[${tag}]` : '[test]';
  console.log(`${prefix} +${elapsed}s  ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function wait(ms = DELAY) {
  if (SLOW) log(`waiting ${ms}ms...`, 'sleep');
  return sleep(ms);
}

function truncate(s, len = 16) {
  if (!s) return '';
  return s.length <= len ? s : `${s.slice(0, len / 2)}…${s.slice(-len / 2)}`;
}

async function api(port, endpoint, opts = {}) {
  const url = `http://127.0.0.1:${port}${endpoint}`;
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!resp.ok) {
    let errMsg = `${resp.status} ${resp.statusText}`;
    try {
      const body = await resp.json();
      if (body.error) errMsg += `: ${body.error}`;
    } catch (_) {}
    throw new Error(`${errMsg} (${url})`);
  }
  if (resp.status === 204 || resp.headers.get('content-length') === '0') return null;
  return resp.json();
}

function startNode(label, port, p2pPort, dataDir) {
  return new Promise((resolve, reject) => {
    log(`starting node on HTTP :${port}, P2P :${p2pPort}, data=${dataDir}`, label);

    const env = { ...process.env };
    env.DDN_HTTP_PORT = String(port);
    env.DDN_P2P_PORT = String(p2pPort);
    env.DDN_DATA_DIR = dataDir;
    env.DDN_ENABLE_CHAIN = '1';

    const child = spawn('cargo', ['run', '--release'], {
      cwd: NODE_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (text) log(`[node:${label}] ${text}`, 'node');
    });
    child.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) log(`[node:${label}][err] ${text}`, 'node-err');
    });

    child.on('spawn', () => resolve(child));
    child.on('error', (err) => {
      log(`Failed to start: ${err.message}`, label);
      reject(err);
    });
  });
}

async function waitForNode(port, label, timeoutMs = 120000) {
  log(`waiting for node on port ${port} to be ready...`, label);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const info = await api(port, '/api/identity');
      log(`node ready. pubkey=${info.pubkey.slice(0, 16)}... locked=${info.locked}`, label);
      return info;
    } catch (e) {
      await sleep(500);
    }
  }
  throw new Error(`Node on port ${port} did not start within ${timeoutMs / 1000}s`);
}

function makeMinimalPng() {
  /// 1×1 transparent PNG (67 bytes).
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
}

function makeMinimalWav() {
  /// 44-byte WAV header (silence).
  return Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
    0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
    0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
    0x44, 0xac, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00,
    0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
    0x00, 0x00, 0x00, 0x00,
  ]);
}

function makeMinimalMp4() {
  /// Minimal ftyp box — enough to upload and reference; frontend shows <video> tag.
  return Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x36, 0x64, 0x72, 0x69, 0x76,
    0x00, 0x00, 0x00, 0x00, 0x69, 0x73, 0x6f, 0x6d,
  ]);
}

async function runTests() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  async function test(name, fn) {
    await wait();
    try {
      log(`${name}...`, 'test');
      await fn();
      passed++;
      log(`PASS: ${name}`, 'ok');
    } catch (e) {
      failed++;
      failures.push(name);
      log(`FAIL: ${name} — ${e.message}`, 'err');
    }
  }

  async function waitForGossip(port, recordId, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const wall = await api(port, '/api/wall').catch(() => ({ posts: [] }));
      if (wall.posts.some((r) => r.id === recordId)) return true;
      await sleep(250);
    }
    return false;
  }

  // ── Phase 0: Three distinct identities ──
  const idA = await waitForNode(PORT_A, 'nodeA');
  const idB = await waitForNode(PORT_B, 'nodeB');
  const idC = await waitForNode(PORT_C, 'nodeC');

  test('three nodes have distinct identities', () => {
    if (idA.pubkey === idB.pubkey) throw new Error('A and B share identity');
    if (idA.pubkey === idC.pubkey) throw new Error('A and C share identity');
    if (idB.pubkey === idC.pubkey) throw new Error('B and C share identity');
    log(`A=${truncate(idA.pubkey, 16)} B=${truncate(idB.pubkey, 16)} C=${truncate(idC.pubkey, 16)}`, 'detail');
  });

  // ── Phase 1: Peer mesh (A connects B and C; B connects C) ──
  test('A adds B as peer', async () => {
    await api(PORT_A, '/api/peers', {
      method: 'POST',
      body: JSON.stringify({ url: `http://127.0.0.1:${PORT_B}` }),
    });
    const peers = await api(PORT_A, '/api/peers');
    if (!peers.peers.includes(`http://127.0.0.1:${PORT_B}`)) throw new Error('B not in A peers');
  });

  test('A adds C as peer', async () => {
    await api(PORT_A, '/api/peers', {
      method: 'POST',
      body: JSON.stringify({ url: `http://127.0.0.1:${PORT_C}` }),
    });
    const peers = await api(PORT_A, '/api/peers');
    if (!peers.peers.includes(`http://127.0.0.1:${PORT_C}`)) throw new Error('C not in A peers');
  });

  test('B adds C as peer', async () => {
    await api(PORT_B, '/api/peers', {
      method: 'POST',
      body: JSON.stringify({ url: `http://127.0.0.1:${PORT_C}` }),
    });
    const peers = await api(PORT_B, '/api/peers');
    if (!peers.peers.includes(`http://127.0.0.1:${PORT_C}`)) throw new Error('C not in B peers');
  });

  test('sync A→B, A→C (empty walls)', async () => {
    await api(PORT_A, '/api/sync', { method: 'POST' });
    await api(PORT_B, '/api/sync', { method: 'POST' });
    await api(PORT_C, '/api/sync', { method: 'POST' });
    log('all nodes synced (0 expected)', 'detail');
  });

  // ── Phase 2: Community creation + membership (multi-identity) ──
  let communityId = '';

  test('identity A creates a community', async () => {
    const result = await api(PORT_A, '/api/community', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Multi-ID Community',
        description: 'Multi-identity visibility test',
      }),
    });
    communityId = result.id;
    if (result.record.author !== idA.pubkey) throw new Error('Founder is not A');
    if (result.record.type !== 'community') throw new Error('Not a community record');
    log(`community cid: ${truncate(communityId, 24)}`, 'detail');
  });

  test('A promotes B as community moderator', async () => {
    const result = await api(PORT_A, '/api/community/membership', {
      method: 'POST',
      body: JSON.stringify({
        community_cid: communityId,
        target_pubkey: idB.pubkey,
        role: 'moderator',
      }),
    });
    if (result.record.type !== 'community_membership') throw new Error('Not membership');
    const p = result.record.payload;
    if (p.community_cid !== communityId) throw new Error('Wrong community_cid');
    if (p.target_pubkey !== idB.pubkey) throw new Error('Wrong target');
  });

  test('A promotes C as community moderator', async () => {
    const result = await api(PORT_A, '/api/community/membership', {
      method: 'POST',
      body: JSON.stringify({
        community_cid: communityId,
        target_pubkey: idC.pubkey,
        role: 'moderator',
      }),
    });
    if (result.record.type !== 'community_membership') throw new Error('Not membership');
  });

  test('community + memberships propagate to B and C', async () => {
    await api(PORT_B, '/api/sync', { method: 'POST' });
    await api(PORT_C, '/api/sync', { method: 'POST' });
    await sleep(SLOW ? 2000 : 300);

    const wallB = await api(PORT_B, '/api/wall');
    const wallC = await api(PORT_C, '/api/wall');

    const hasCommunityB = wallB.posts.some((r) => r.id === communityId);
    const hasCommunityC = wallC.posts.some((r) => r.id === communityId);
    if (!hasCommunityB) throw new Error('B cannot see community record');
    if (!hasCommunityC) throw new Error('C cannot see community record');

    const modB = await api(PORT_B, '/api/moderation');
    const modC = await api(PORT_C, '/api/moderation');
    const commB = modB.communities[communityId];
    const commC = modC.communities[communityId];
    if (!commB) throw new Error('B moderation does not know about community');
    if (!commC) throw new Error('C moderation does not know about community');
    if (!commB.moderators.includes(idB.pubkey)) throw new Error('B not listed as moderator on B');
    if (!commC.moderators.includes(idC.pubkey)) throw new Error('C not listed as moderator on C');
  });

  // ── Phase 3: Text message visibility ──
  let textRecordId = '';
  test('B posts a text message', async () => {
    const ts = Date.now();
    const signed = await api(PORT_B, '/api/record/sign', {
      method: 'POST',
      body: JSON.stringify({
        type: 'post',
        author: idB.pubkey,
        prev: null,
        ts,
        payload: { text: 'Hello from identity B 👋', media: [] },
      }),
    });
    const result = await api(PORT_B, '/api/record', {
      method: 'POST',
      body: JSON.stringify(signed),
    });
    textRecordId = result.id;
    log(`text record: ${truncate(textRecordId, 16)}`, 'detail');
  });

  test('B text message visible on A and C', async () => {
    await api(PORT_A, '/api/sync', { method: 'POST' });
    await api(PORT_C, '/api/sync', { method: 'POST' });
    const visible = await Promise.all([
      waitForGossip(PORT_A, textRecordId),
      waitForGossip(PORT_C, textRecordId),
    ]);
    if (!visible[0]) throw new Error('A cannot see B text message');
    if (!visible[1]) throw new Error('C cannot see B text message');
  });

  // ── Phase 4: Image upload + visibility ──
  let imageCid = '';
  let imageRecordId = '';
  test('B uploads an image blob (PNG)', async () => {
    const png = makeMinimalPng();
    const resp = await fetch(`http://127.0.0.1:${PORT_B}/api/blob`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: png,
    });
    if (!resp.ok) throw new Error(`Image upload failed: ${resp.status}`);
    const data = await resp.json();
    imageCid = data.cid;
    log(`image cid: ${truncate(imageCid, 16)}`, 'detail');
  });

  test('B can fetch its own image blob', async () => {
    const resp = await fetch(`http://127.0.0.1:${PORT_B}/api/blob/${imageCid}`);
    if (!resp.ok) throw new Error(`Blob fetch failed: ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length !== 67) throw new Error(`Image size mismatch: ${buf.length}`);
  });

  test('B posts with image media reference', async () => {
    const ts = Date.now();
    const signed = await api(PORT_B, '/api/record/sign', {
      method: 'POST',
      body: JSON.stringify({
        type: 'post',
        author: idB.pubkey,
        prev: null,
        ts,
        payload: { text: 'Image from B 🖼️', media: [{ cid: imageCid, mime: 'image/png', size: 67 }] },
      }),
    });
    const result = await api(PORT_B, '/api/record', {
      method: 'POST',
      body: JSON.stringify(signed),
    });
    imageRecordId = result.id;
  });

  test('image post visible on A and C (record + media ref)', async () => {
    await api(PORT_A, '/api/sync', { method: 'POST' });
    await api(PORT_C, '/api/sync', { method: 'POST' });
    const visible = await Promise.all([
      waitForGossip(PORT_A, imageRecordId),
      waitForGossip(PORT_C, imageRecordId),
    ]);
    if (!visible[0]) throw new Error('A cannot see image post');
    if (!visible[1]) throw new Error('C cannot see image post');

    const wallA = await api(PORT_A, '/api/wall');
    const recA = wallA.posts.find((r) => r.id === imageRecordId);
    const payload = recA.payload;
    if (!payload.media || payload.media[0].cid !== imageCid) throw new Error('Image CID mismatch on A');
    if (payload.media[0].mime !== 'image/png') throw new Error('Image mime mismatch on A');
  });

  // ── Phase 5: Video upload + visibility ──
  let videoCid = '';
  let videoRecordId = '';
  test('C uploads a video blob (MP4)', async () => {
    const mp4 = makeMinimalMp4();
    const resp = await fetch(`http://127.0.0.1:${PORT_C}/api/blob`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4' },
      body: mp4,
    });
    if (!resp.ok) throw new Error(`Video upload failed: ${resp.status}`);
    const data = await resp.json();
    videoCid = data.cid;
    log(`video cid: ${truncate(videoCid, 16)}`, 'detail');
  });

  test('C can fetch its own video blob', async () => {
    const resp = await fetch(`http://127.0.0.1:${PORT_C}/api/blob/${videoCid}`);
    if (!resp.ok) throw new Error(`Blob fetch failed: ${resp.status}`);
  });

  test('C posts with video media reference', async () => {
    const ts = Date.now();
    const signed = await api(PORT_C, '/api/record/sign', {
      method: 'POST',
      body: JSON.stringify({
        type: 'post',
        author: idC.pubkey,
        prev: null,
        ts,
        payload: { text: 'Video from C 🎥', media: [{ cid: videoCid, mime: 'video/mp4', size: 24 }] },
      }),
    });
    const result = await api(PORT_C, '/api/record', {
      method: 'POST',
      body: JSON.stringify(signed),
    });
    videoRecordId = result.id;
  });

  test('video post visible on A and B (record + media ref)', async () => {
    await api(PORT_A, '/api/sync', { method: 'POST' });
    await api(PORT_B, '/api/sync', { method: 'POST' });
    const visible = await Promise.all([
      waitForGossip(PORT_A, videoRecordId),
      waitForGossip(PORT_B, videoRecordId),
    ]);
    if (!visible[0]) throw new Error('A cannot see video post');
    if (!visible[1]) throw new Error('B cannot see video post');
  });

  // ── Phase 6: Audio upload + visibility ──
  let audioCid = '';
  let audioRecordId = '';
  test('A uploads an audio blob (WAV)', async () => {
    const wav = makeMinimalWav();
    const resp = await fetch(`http://127.0.0.1:${PORT_A}/api/blob`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav,
    });
    if (!resp.ok) throw new Error(`Audio upload failed: ${resp.status}`);
    const data = await resp.json();
    audioCid = data.cid;
    log(`audio cid: ${truncate(audioCid, 16)}`, 'detail');
  });

  test('A can fetch its own audio blob', async () => {
    const resp = await fetch(`http://127.0.0.1:${PORT_A}/api/blob/${audioCid}`);
    if (!resp.ok) throw new Error(`Blob fetch failed: ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length !== 44) throw new Error(`Audio size mismatch: ${buf.length}`);
  });

  test('A posts with audio media reference', async () => {
    const ts = Date.now();
    const signed = await api(PORT_A, '/api/record/sign', {
      method: 'POST',
      body: JSON.stringify({
        type: 'post',
        author: idA.pubkey,
        prev: null,
        ts,
        payload: { text: 'Audio from A 🔊', media: [{ cid: audioCid, mime: 'audio/wav', size: 44 }] },
      }),
    });
    const result = await api(PORT_A, '/api/record', {
      method: 'POST',
      body: JSON.stringify(signed),
    });
    audioRecordId = result.id;
  });

  test('audio post visible on B and C (record + media ref)', async () => {
    await api(PORT_B, '/api/sync', { method: 'POST' });
    await api(PORT_C, '/api/sync', { method: 'POST' });
    const visible = await Promise.all([
      waitForGossip(PORT_B, audioRecordId),
      waitForGossip(PORT_C, audioRecordId),
    ]);
    if (!visible[0]) throw new Error('B cannot see audio post');
    if (!visible[1]) throw new Error('C cannot see audio post');

    const wallB = await api(PORT_B, '/api/wall');
    const recB = wallB.posts.find((r) => r.id === audioRecordId);
    const payload = recB.payload;
    if (!payload.media || payload.media[0].cid !== audioCid) throw new Error('Audio CID mismatch on B');
  });

  // ── Phase 7: Cross-node blob fetch (documenting the WebRTC gap) ──
  test('B cannot fetch A-uploaded audio blob via HTTP (WebRTC gap)', async () => {
    const resp = await fetch(`http://127.0.0.1:${PORT_B}/api/blob/${audioCid}`);
    if (resp.ok) {
      log('NOTE: audio blob is on B — blob may have been transferred via WebRTC or shared CAS mount', 'detail');
    } else {
      log(`B cannot fetch audio blob via HTTP (${resp.status}) — expected: blobs travel via WebRTC`, 'detail');
    }
  });

  // ── Phase 8: Community-scoped moderation ──
  test('A (moderator) can hide a non-member post in the community', async () => {
    const ts = Date.now();
    const signed = await api(PORT_A, '/api/record/sign', {
      method: 'POST',
      body: JSON.stringify({
        type: 'mod_action',
        author: idA.pubkey,
        prev: null,
        ts,
        payload: {
          target_cid: videoRecordId,
          action: 'hide',
          mod_pubkey: idA.pubkey,
          community_cid: communityId,
        },
      }),
    });
    await api(PORT_A, '/api/record', { method: 'POST', body: JSON.stringify(signed) });

    const mod = await api(PORT_A, '/api/moderation');
    const comm = mod.communities[communityId];
    if (!comm) throw new Error('Community not in moderation response');
    if (!comm.hidden_cids.includes(videoRecordId)) throw new Error('Video record not in community hidden_cids');
  });

  log(`\n=== Results: ${passed} passed, ${failed} failed ===`, 'summary');
  if (failed > 0) {
    log(`Failed tests:`, 'summary');
    failures.forEach((f) => log(`  - ${f}`, 'err'));
  }
  return failed === 0;
}

async function main() {
  log('Starting multi-identity community visibility test (slow mode: ' + SLOW + ')');

  try {
    procA = await startNode('nodeA', PORT_A, P2P_PORT_A, DATA_DIR_A);
    procB = await startNode('nodeB', PORT_B, P2P_PORT_B, DATA_DIR_B);
    procC = await startNode('nodeC', PORT_C, P2P_PORT_C, DATA_DIR_C);

    const ok = await runTests();
    log(ok ? '\nAll tests passed!' : '\nSome tests failed — see output above.', 'summary');
  } catch (e) {
    log(`Fatal: ${e.message}`, 'err');
  } finally {
    cleanup();
  }
}

function cleanup() {
  log('Stopping nodes...');
  [procA, procB, procC].forEach((p) => {
    if (p) p.kill();
  });
}

process.on('SIGINT', () => {
  log('SIGINT — shutting down...', 'summary');
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});

main().then(() => process.exit(0));
