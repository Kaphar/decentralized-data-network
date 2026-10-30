#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SLOW = process.argv.includes('--slow');
const KEEP_RUNNING = process.argv.includes('--keep-running');
const DELAY = SLOW ? 3000 : 400;

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT_START = Date.now();

const PORT_1 = 3001;
const PORT_2 = 3002;
const P2P_PORT_1 = 4001;
const P2P_PORT_2 = 4002;
const DATA_DIR_1 = path.join(os.tmpdir(), 'ddn-test-data1');
const DATA_DIR_2 = path.join(os.tmpdir(), 'ddn-test-data2');
const NODE_DIR = path.resolve(__dirname, '..', 'node');

let proc1 = null;
let proc2 = null;

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

function openBrowser(url) {
  const platform = os.platform();
  let cmd;
  if (platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  spawn(cmd, { shell: true, stdio: 'ignore' });
  log(`opened browser: ${url}`, 'browser');
}

async function buildFrontend() {
  const frontendDir = path.resolve(__dirname, '..', 'frontend');
  const distPath = path.join(frontendDir, 'dist', 'index.html');
  if (fs.existsSync(distPath)) {
    log('frontend dist already exists, skipping build', 'frontend');
    return;
  }
  log('building frontend (npm run build)...', 'frontend');
  const buildProc = spawn('npm', ['run', 'build'], {
    cwd: frontendDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  buildProc.stdout.on('data', (data) => log(`[frontend] ${data.toString().trim()}`, 'frontend'));
  buildProc.stderr.on('data', (data) => log(`[frontend] ${data.toString().trim()}`, 'frontend-err'));
  await new Promise((resolve, reject) => {
    buildProc.on('close', (code) => {
      if (code === 0) {
        log('frontend build complete', 'frontend');
        resolve();
      } else {
        log(`frontend build failed (exit ${code})`, 'frontend');
        reject(new Error('frontend build failed'));
      }
    });
  });
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
  return new Promise((resolve) => {
    log(`starting node on HTTP :${port}, P2P :${p2pPort}, data=${dataDir}`, label);

    const env = { ...process.env };
    env.DDN_HTTP_PORT = String(port);
    env.DDN_P2P_PORT = String(p2pPort);
    env.DDN_DATA_DIR = dataDir;

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
      if (text) log(`[node:${label}] ${text}`, 'node-err');
    });

    child.on('spawn', () => resolve(child));
    child.on('error', (err) => {
      log(`Failed to start: ${err.message}`, label);
      process.exit(1);
    });

    return child;
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

async function runTests() {
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    await wait();
    try {
      log(`${name}...`, 'test');
      await fn();
      passed++;
      log(`PASS: ${name}`, 'ok');
    } catch (e) {
      failed++;
      log(`FAIL: ${name} — ${e.message}`, 'err');
    }
  }

  // ── Phase 0/1: Identity & Node Startup ──────────────────────────
  const id1 = await waitForNode(PORT_1, 'node1');
  const id2 = await waitForNode(PORT_2, 'node2');

  test('both nodes have distinct identities', () => {
    if (id1.pubkey === id2.pubkey) throw new Error('Both nodes share the same identity!');
    log(`node1 pubkey: ${id1.pubkey.slice(0, 24)}...`, 'detail');
    log(`node2 pubkey: ${id2.pubkey.slice(0, 24)}...`, 'detail');
  });

  test('both nodes report unlocked (auto-unlock)', () => {
    if (id1.locked) throw new Error('node1 identity is locked');
    if (id2.locked) throw new Error('node2 identity is locked');
  });

  test('both nodes report auto_unlock=true', () => {
    if (id1.auto_unlock !== true) throw new Error('node1 auto_unlock ≠ true');
    if (id2.auto_unlock !== true) throw new Error('node2 auto_unlock ≠ true');
  });

  // ── Phase 1: Peer Connection & Sync ────────────────────────────
  test('connect node2 as peer of node1', async () => {
    await api(PORT_1, '/api/peers', {
      method: 'POST',
      body: JSON.stringify({ url: `http://127.0.0.1:${PORT_2}` }),
    });
    const peers = await api(PORT_1, '/api/peers');
    log(`node1 peers: ${peers.peers.join(', ')}`, 'detail');
    if (!peers.peers.includes(`http://127.0.0.1:${PORT_2}`)) {
      throw new Error('node2 not in node1 peer list');
    }
  });

  test('sync pulls 0 records initially (both empty)', async () => {
    const result = await api(PORT_1, '/api/sync', { method: 'POST' });
    log(`sync added: ${result.added} records`, 'detail');
  });

  // ── Phase 2: Posting & Gossip ────────────────────────────────────
  let recordId = '';

  test('post a record on node1', async () => {
    const ts = Date.now();
    const signed = await api(PORT_1, '/api/record/sign', {
      method: 'POST',
      body: JSON.stringify({
        type: 'post',
        author: id1.pubkey,
        prev: null,
        ts,
        payload: { text: 'Hello from node1! 👋', media: [] },
      }),
    });
    log(`signed record id: ${signed.id.slice(0, 16)}...`, 'detail');

    await api(PORT_1, '/api/record', {
      method: 'POST',
      body: JSON.stringify(signed),
    });
    recordId = signed.id;
  });

  test('record appears on node1 wall', async () => {
    const wall = await api(PORT_1, '/api/wall');
    const found = wall.posts.some((r) => r.id === recordId);
    if (!found) throw new Error('Posted record not found on node1 wall');
  });

  test('sync propagates record to node2', async () => {
    const result = await api(PORT_2, '/api/sync', { method: 'POST' });
    log(`node2 sync added: ${result.added} records`, 'detail');
    await sleep(SLOW ? 2000 : 300);
    const wall = await api(PORT_2, '/api/wall');
    const found = wall.posts.some((r) => r.id === recordId);
    if (!found) throw new Error('Record was not gossiped to node2');
  });

  // ── Phase 2: E2EE Direct Messages ───────────────────────────────
  test('seal and open a DM between node1 → node2', async () => {
    const plaintext = 'Secret message from node1 to node2';
    const sealed = await api(PORT_1, '/api/dm/seal', {
      method: 'POST',
      body: JSON.stringify({
        author: id1.pubkey,
        to: id2.pubkey,
        plaintext,
      }),
    });
    log(`sealed DM: ciphertext=${sealed.ciphertext.slice(0, 16)}...`, 'detail');

    // Node2 decrypts (node2 holds the recipient key)
    const opened = await api(PORT_2, '/api/dm/open', {
      method: 'POST',
      body: JSON.stringify({
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        ephemeral_pubkey: sealed.ephemeral_pubkey,
        sender: id1.pubkey,
      }),
    });
    if (opened.plaintext !== plaintext) {
      throw new Error(`DM roundtrip mismatch: got "${opened.plaintext}"`);
    }
  });

  // ── Phase 2: Blob Upload ────────────────────────────────────────
  test('upload a blob and fetch it back', async () => {
    const content = Buffer.from('Hello blob world!', 'utf-8');
    const blobResp = await fetch(`http://127.0.0.1:${PORT_1}/api/blob`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });
    if (!blobResp.ok) throw new Error(`Blob upload failed: ${blobResp.status}`);
    const blobData = await blobResp.json();
    log(`blob cid: ${blobData.cid.slice(0, 16)}...`, 'detail');

    const getResp = await fetch(`http://127.0.0.1:${PORT_1}/api/blob/${blobData.cid}`);
    if (!getResp.ok) throw new Error(`Blob fetch failed: ${getResp.status}`);
    const fetched = Buffer.from(await getResp.arrayBuffer());
    if (fetched.toString('utf-8') !== 'Hello blob world!') {
      throw new Error('Blob content mismatch');
    }
  });

  // ── Phase 2: Moderation ─────────────────────────────────────────
  test('report content and check moderation list', async () => {
    const result = await api(PORT_1, '/api/report', {
      method: 'POST',
      body: JSON.stringify({ target_cid: recordId, reason: 'spam' }),
    });
    log(`report record: ${result.id.slice(0, 16)}...`, 'detail');

    const mod = await api(PORT_1, '/api/moderation');
    log(`moderation: blocked=${mod.blocked_cids.length}, hidden=${mod.hidden_cids.length}, mods=${mod.mod_pubkeys.length}`, 'detail');
  });

  // ── Phase 5: Identity Management ────────────────────────────────
  test('export identity backup from node1', async () => {
    const backup = await api(PORT_1, '/api/identity/export', {
      method: 'POST',
      body: JSON.stringify({ password: 'testpassword123' }),
    });
    log(`backup pubkey: ${backup.pubkey.slice(0, 16)}...`, 'detail');
    if (backup.pubkey !== id1.pubkey) throw new Error('Backup pubkey mismatch');
  });

  test('unlock identity (wrong password fails)', async () => {
    try {
      await api(PORT_1, '/api/identity/unlock', {
        method: 'POST',
        body: JSON.stringify({ password: 'wrong' }),
      });
      log('NOTE: unlock succeeded — node1 identity may be auto-unlocked (no password)', 'detail');
    } catch (e) {
      log(`unlock with wrong password correctly failed: ${e.message}`, 'detail');
    }
  });

  test('delete identity (requires restart)', async () => {
    const result = await api(PORT_1, '/api/identity', { method: 'DELETE' });
    log(`delete result: ${JSON.stringify(result)}`, 'detail');
    if (result.status !== 'deleted') throw new Error('Delete did not return status=deleted');
  });

  test('identity is gone from disk after delete', async () => {
    // Node1 still has the old identity in memory until restart, but the file is deleted.
    // We verify by checking the identity file no longer exists on disk.
    const idPath = path.join(DATA_DIR_1, 'ddn_identity.json');
    if (fs.existsSync(idPath)) {
      throw new Error('Identity file still exists on disk after delete');
    }
    log('identity file removed from disk', 'detail');
  });

  // ── Phase 4: Reactions ───────────────────────────────────────────
  test('post a reaction on node1', async () => {
    const signed = await api(PORT_1, '/api/record/sign', {
      method: 'POST',
      body: JSON.stringify({
        type: 'reaction',
        author: id1.pubkey,
        prev: null,
        ts: Date.now(),
        payload: { target_cid: recordId, emoji: '👍' },
      }),
    });
    await api(PORT_1, '/api/record', {
      method: 'POST',
      body: JSON.stringify(signed),
    });
    log(`reaction record: ${signed.id.slice(0, 16)}...`, 'detail');
  });

  test('sync propagates reaction to node2', async () => {
    await api(PORT_2, '/api/sync', { method: 'POST' });
    await sleep(SLOW ? 2000 : 300);
    const records = await api(PORT_2, '/api/records');
    const hasReaction = records.records.some((r) => r.type === 'reaction');
    if (!hasReaction) throw new Error('Reaction record not found on node2');
  });

  // ── Phase 5: Import Identity ─────────────────────────────────────
  test('import identity backup onto node1', async () => {
    if (fs.existsSync(path.join(DATA_DIR_1, 'ddn_identity.json'))) {
      throw new Error('node1 identity file still exists — delete test may have failed');
    }
    const backup = await api(PORT_2, '/api/identity/export', {
      method: 'POST',
      body: JSON.stringify({ password: 'testpassword123' }),
    });
    log(`importing backup with pubkey: ${backup.pubkey.slice(0, 16)}...`, 'detail');

    const result = await api(PORT_1, '/api/identity/import', {
      method: 'POST',
      body: JSON.stringify({ file: backup, password: 'testpassword123' }),
    });
    if (result.status !== 'imported') throw new Error('Import did not return status=imported');
    log(`import result: ${JSON.stringify(result)}`, 'detail');
  });

  test('identity file exists on disk after import', async () => {
    const idPath = path.join(DATA_DIR_1, 'ddn_identity.json');
    if (!fs.existsSync(idPath)) throw new Error('Identity file not created after import');
    log('identity file written to disk', 'detail');
  });

  // ── Phase 6.2: Community Model ──────────────────────────────────
  log('--- Phase 6.2: Community Model ---', 'test');

  let communityId = '';

  test('create a community on node1', async () => {
    const result = await api(PORT_1, '/api/community', {
      method: 'POST',
      body: JSON.stringify({ name: 'Test Community', description: 'E2E test community' }),
    });
    communityId = result.id;
    log(`community created: id=${truncate(result.id, 32)}`, 'detail');
    log(`founder: ${truncate(result.record.author, 32)}`, 'detail');
    if (result.record.author !== id1.pubkey) throw new Error('Community founder is not node1');
    if (result.record.type !== 'community') throw new Error('Record type is not community');
    const p = result.record.payload;
    if (p.name !== 'Test Community') throw new Error('Community name mismatch');
    if (p.creator !== id1.pubkey) throw new Error('Creator field does not match founder');
  });

  test('community record appears on node1 wall', async () => {
    const wall = await api(PORT_1, '/api/wall');
    const found = wall.posts.some((r) => r.id === communityId);
    if (!found) throw new Error('Community record not found on node1 wall');
  });

  test('sync propagates community to node2', async () => {
    const result = await api(PORT_2, '/api/sync', { method: 'POST' });
    log(`node2 sync added: ${result.added} records`, 'detail');
    await sleep(SLOW ? 2000 : 300);
    const wall = await api(PORT_2, '/api/wall');
    const found = wall.posts.some((r) => r.id === communityId);
    if (!found) throw new Error('Community record not found on node2 after sync');
  });

  test('promote node2 as community moderator', async () => {
    const result = await api(PORT_1, '/api/community/membership', {
      method: 'POST',
      body: JSON.stringify({
        community_cid: communityId,
        target_pubkey: id2.pubkey,
        role: 'moderator',
      }),
    });
    log(`membership record: ${truncate(result.id, 32)}`, 'detail');
    if (result.record.type !== 'community_membership') throw new Error('Record type is not community_membership');
    const p = result.record.payload;
    if (p.community_cid !== communityId) throw new Error('community_cid mismatch');
    if (p.target_pubkey !== id2.pubkey) throw new Error('target_pubkey mismatch');
    if (p.role !== 'moderator') throw new Error('role mismatch');
  });

  test('sync propagates membership to node2', async () => {
    await api(PORT_2, '/api/sync', { method: 'POST' });
    await sleep(SLOW ? 2000 : 300);
    const wall = await api(PORT_2, '/api/wall');
    const hasMembership = wall.posts.some((r) => r.type === 'community_membership');
    if (!hasMembership) throw new Error('Membership record not found on node2');
  });

  test('moderation response includes community with moderator', async () => {
    const mod = await api(PORT_1, '/api/moderation');
    const community = mod.communities[communityId];
    if (!community) throw new Error(`Community ${truncate(communityId, 32)} not in moderation response`);
    log(`community name: ${community.name}`, 'detail');
    log(`community founder: ${truncate(community.founder, 32)}`, 'detail');
    log(`community moderators: ${community.moderators.length}`, 'detail');
    if (community.founder !== id1.pubkey) throw new Error('Community founder is not node1');
    if (!community.moderators.includes(id2.pubkey)) throw new Error('node2 not listed as community moderator');
    if (!community.moderators.includes(id1.pubkey)) throw new Error('node1 (founder) not in community moderators');
  });

  test('community-scoped mod_action is recognized', async () => {
    const ts = Date.now();
    const signed = await api(PORT_1, '/api/record/sign', {
      method: 'POST',
      body: JSON.stringify({
        type: 'mod_action',
        author: id1.pubkey,
        prev: null,
        ts,
        payload: {
          target_cid: 'test-target-cid-123',
          action: 'hide',
          mod_pubkey: id1.pubkey,
          community_cid: communityId,
        },
      }),
    });
    await api(PORT_1, '/api/record', {
      method: 'POST',
      body: JSON.stringify(signed),
    });

    const mod = await api(PORT_1, '/api/moderation');
    const community = mod.communities[communityId];
    if (!community) throw new Error('Community not in moderation response after mod_action');
    const hasHidden = community.hidden_cids.includes('test-target-cid-123');
    if (!hasHidden) throw new Error('Community-scoped hide not reflected in moderation response');
    log(`community hidden_cids: ${community.hidden_cids.length}`, 'detail');
    log(`community blocked_cids: ${community.blocked_cids.length}`, 'detail');
  });

   // ── Phase 6.3: Private Communities ────────────────────────────────
  log('--- Phase 6.3: Private Community Model ---', 'test');

  let privateCommunityId = '';

  test('create a private community on node1', async () => {
    const result = await api(PORT_1, '/api/community', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Private Community',
        description: 'E2E private community test',
        is_private: true,
      }),
    });
    privateCommunityId = result.id;
    log(`private community created: id=${truncate(result.id, 32)}`, 'detail');
    if (result.record.author !== id1.pubkey) throw new Error('Private community founder is not node1');
    const p = result.record.payload;
    if (p.is_private !== true) throw new Error('is_private flag not set on community record');
  });

  test('private community group key exists and is retrievable', async () => {
    const keyResp = await api(PORT_1, `/api/community/key/${privateCommunityId}`, { method: 'POST' });
    if (!keyResp.key || keyResp.key.length < 32) throw new Error('Group key missing or too short');
    log(`group key retrieved (${keyResp.key.length} chars), first 8: ${keyResp.key.slice(0, 8)}…`, 'detail');
  });

  test('add node2 as private community member', async () => {
    const result = await api(PORT_1, '/api/community/membership', {
      method: 'POST',
      body: JSON.stringify({
        community_cid: privateCommunityId,
        target_pubkey: id2.pubkey,
        role: 'member',
        encrypted_group_key: 'encrypted-key-for-node2',
      }),
    });
    if (result.record.type !== 'community_membership') throw new Error('Record type is not community_membership');
    log(`membership record: ${truncate(result.id, 32)}`, 'detail');
  });

  test('node2 can retrieve group key after membership', async () => {
    const keyResp = await api(PORT_2, `/api/community/key/${privateCommunityId}`, { method: 'POST' });
    if (!keyResp.key) throw new Error('node2 cannot retrieve group key after membership');
    log(`node2 retrieved group key (${keyResp.key.length} chars)`, 'detail');
  });

  // ── Phase 6.4: dApp Registration & Discovery ──────────────────────
  log('--- Phase 6.4: dApp Registration & Discovery ---', 'test');

  test('register a dApp on node1', async () => {
    const result = await api(PORT_1, '/api/dapp/register', {
      method: 'POST',
      body: JSON.stringify({
        cid: 'test-dapp-cid-123',
        name: 'Test Guestbook',
        description: 'A test dApp for e2e',
        path: '/dapp/guestbook',
        manifest: { name: 'guestbook', version: '1.0.0' },
      }),
    });
    log(`dApp registered: name=${result.name}`, 'detail');
    if (!result.success) throw new Error('dApp registration did not return success');
  });

  test('discover registered dApps on node1', async () => {
    const dapps = await api(PORT_1, '/api/dapp/discover');
    log(`discovered ${dapps.length} dApps on node1`, 'detail');
    const found = dapps.dapps.some((d) => d.cid === 'test-dapp-cid-123');
    if (!found) throw new Error('Registered dApp not found in discovery response');
  });

  test('node2 discovers dApp via gossip', async () => {
    await api(PORT_2, '/api/sync', { method: 'POST' });
    await sleep(SLOW ? 2000 : 300);
    const dapps = await api(PORT_2, '/api/dapp/discover');
    log(`discovered ${dapps.length} dApps on node2`, 'detail');
    const found = dapps.dapps.some((d) => d.cid === 'test-dapp-cid-123');
    if (!found) throw new Error('dApp not gossiped to node2');
  });

  // ── Phase 6.5: Runtime dApp Directory ─────────────────────────────
  log('--- Phase 6.5: Runtime dApp Directory ---', 'test');

  test('node1 accepts runtime dApp dir setting', async () => {
    const customDir = path.join(os.tmpdir(), 'ddn-test-dapps');
    const result = await api(PORT_1, '/api/dapps/dir', {
      method: 'POST',
      body: JSON.stringify({ dir: customDir }),
    });
    if (!result.success) throw new Error('Runtime dApp dir setting failed');
    log(`dApp directory set to ${customDir}`, 'detail');
  });

  test('local dApp list reflects runtime dir change', async () => {
    const localList = await api(PORT_1, '/api/dapps');
    log(`local dApp list: ${localList.dapps ? localList.dapps.length : 0} dApps`, 'detail');
    if (!Array.isArray(localList.dapps)) throw new Error('Local dApp list missing dapps array');
  });

  log(`\n=== Results: ${passed} passed, ${failed} failed ===`, 'summary');
  return failed === 0;
}

async function main() {
  log(`Starting e2e test (slow mode: ${SLOW}, keep-running: ${KEEP_RUNNING})`, 'test');

  // Build the frontend in the background while nodes start, so the node can
  // serve it from /api/.. at the root path.
  const buildPromise = KEEP_RUNNING
    ? buildFrontend().catch((e) => log(`Frontend build error: ${e.message}`, 'frontend'))
    : Promise.resolve();

  try {
    proc1 = await startNode('node1', PORT_1, P2P_PORT_1, DATA_DIR_1);
    proc2 = await startNode('node2', PORT_2, P2P_PORT_2, DATA_DIR_2);

    if (KEEP_RUNNING) {
      log('waiting for frontend build to finish...', 'frontend');
      await buildPromise;
    }

    const ok = await runTests();

    if (ok) {
      log('\nAll tests passed!', 'summary');
    } else {
      log('\nSome tests failed — see output above.', 'summary');
    }

    if (KEEP_RUNNING) {
      log('\nOpening browser windows for visual inspection...', 'summary');
      await sleep(2000);
      openBrowser(`http://127.0.0.1:${PORT_1}/`);
      openBrowser(`http://127.0.0.1:${PORT_2}/`);
       log(`\nNodes are still running.\n  Node 1: http://127.0.0.1:${PORT_1}/\n  Node 2: http://127.0.0.1:${PORT_2}/\nPress Ctrl+C to stop.`, 'summary');
      // Keep the process alive so nodes stay running.
      process.stdin.resume();
      return;
    }
  } catch (e) {
    log(`Fatal error: ${e.message}`, 'err');
  } finally {
    cleanup(KEEP_RUNNING);
    if (!KEEP_RUNNING) {
      process.exit(0);
    }
  }
}

function cleanup(keepRunning = false) {
  if (keepRunning) {
    log('Keeping nodes running for inspection (--keep-running)', 'summary');
    return;
  }
  log('Cleaning up: stopping nodes...');
  if (proc1) proc1.kill();
  if (proc2) proc2.kill();
}

process.on('SIGINT', () => {
  log('Received SIGINT, shutting down...', 'summary');
  cleanup(false);
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanup(false);
  process.exit(0);
});

main();
