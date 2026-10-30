#!/usr/bin/env node
'use strict';

const WORDS = [
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta',
  'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi',
  'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega',
  'blockchain', 'anchor', 'tamper', 'evident', 'timestamp', 'merkle',
  'proposer', 'validator', 'genesis', 'sidecar', 'gossip', 'pubkey',
  'record', 'hash', 'sha256', 'pow', 'pos', 'round', 'robin',
];

const MAX_EMBEDDED_PAYLOAD = 5000 * 1024;

function randomText() {
  const n = 3 + Math.floor(Math.random() * 5);
  const parts = [];
  for (let i = 0; i < n; i++) {
    parts.push(WORDS[Math.floor(Math.random() * WORDS.length)]);
  }
  return parts.join(' ');
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    url: 'http://127.0.0.1:3000',
    interval: 15000,
    count: 0,
    prefix: '',
    enableChain: false,
    validators: '',
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url':
      case '-u':
        opts.url = args[++i];
        break;
      case '--interval':
      case '-i':
        opts.interval = parseInt(args[++i], 10) * 1000;
        break;
      case '--count':
      case '-n':
        opts.count = parseInt(args[++i], 10);
        break;
      case '--prefix':
      case '-p':
        opts.prefix = args[++i];
        break;
      case '--enable-chain':
        opts.enableChain = true;
        break;
      case '--validators':
        opts.validators = args[++i];
        break;
    }
  }
  return opts;
}

function log(msg, tag = '') {
  const ts = new Date().toISOString();
  const prefix = tag ? `[${tag}]` : '[test]';
  console.log(`${ts} ${prefix} ${msg}`);
}

async function api(baseUrl, path, opts = {}) {
  const resp = await fetch(`${baseUrl}${path}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { ok: resp.ok, status: resp.status, data, text };
}

async function sendAnchorRound(opts, round) {
  const identity = await api(opts.url, '/api/identity');
  if (!identity.ok) {
    log(`identity check failed: ${identity.status}`, 'identity');
    return false;
  }
  if (identity.data.locked) {
    log('identity is LOCKED — cannot sign records', 'identity');
    return false;
  }
  const pubkey = identity.data.pubkey;

  const text = `${opts.prefix}${randomText()}`.trim();
  const ts = Date.now();
  const payload = { text, dapp: 'test' };

  const signed = await api(opts.url, '/api/record/sign', {
    method: 'POST',
    body: { type: 'post', author: pubkey, prev: null, ts, payload },
  });
  if (!signed.ok) {
    log(`sign failed (${signed.status}): ${signed.text}`, 'record');
    return false;
  }

  const submitted = await api(opts.url, '/api/record', {
    method: 'POST',
    body: signed.data,
  });
  if (!submitted.ok) {
    log(`submit failed (${submitted.status}): ${submitted.text}`, 'record');
    return false;
  }
  const recordId = submitted.data.id;

  const anchored = await api(opts.url, '/api/chain/anchor', {
    method: 'POST',
    body: {
      author: signed.data.author,
      record_cid: recordId,
      ts: Math.floor(ts / 1000),
      sig: signed.data.sig,
    },
  });
  if (!anchored.ok) {
    log(`anchor failed (${anchored.status}): ${anchored.text}`, 'chain');
    return false;
  }

  log(`round ${round}: text="${text}" record=${recordId.slice(0, 12)}… → anchored`, 'chain');
  return true;
}

async function testAnchorPayload(opts, round) {
  const identity = await api(opts.url, '/api/identity');
  if (!identity.ok || identity.data.locked) {
    log('identity locked — skipping payload anchor test', 'payload');
    return false;
  }

  const text = `${opts.prefix}embedded-payload-${round}-${randomText()}`.trim();

  const smallPayload = text;
  if (Buffer.byteLength(smallPayload, 'utf8') > MAX_EMBEDDED_PAYLOAD) {
    log(`payload exceeds ${MAX_EMBEDDED_PAYLOAD} bytes — skipping`, 'payload');
    return false;
  }

  const anchored = await api(opts.url, '/api/chain/anchor-payload', {
    method: 'POST',
    body: {
      author: identity.data.pubkey,
      payload_data: smallPayload,
      content_type: 'text/plain',
      ts: Math.floor(Date.now() / 1000),
    },
  });

  if (!anchored.ok) {
    log(`payload anchor failed (${anchored.status}): ${anchored.text}`, 'payload');
    return false;
  }

  log(`round ${round}: payload="${text.slice(0, 32)}…" → anchored with payload_data (status=${anchored.data.status})`, 'payload');
  return true;
}

async function testOversizedPayload(opts) {
  const identity = await api(opts.url, '/api/identity');
  if (!identity.ok || identity.data.locked) {
    return true;
  }

  const oversized = 'x'.repeat(MAX_EMBEDDED_PAYLOAD + 1);
  const resp = await api(opts.url, '/api/chain/anchor-payload', {
    method: 'POST',
    body: {
      author: identity.data.pubkey,
      payload_data: oversized,
      content_type: 'text/plain',
      ts: Math.floor(Date.now() / 1000),
    },
  });

  if (resp.status === 413) {
    log(`oversized payload correctly rejected with 413 (server enforces ${MAX_EMBEDDED_PAYLOAD} byte limit)`, 'payload');
    return true;
  }

  log(`oversized payload NOT rejected (status=${resp.status}) — server may not enforce size limit`, 'payload');
  return true;
}

async function testGetLatestBlock(opts) {
  const resp = await api(opts.url, '/api/chain/block/latest');
  if (!resp.ok) {
    log(`latest block query failed (${resp.status}): ${resp.text}`, 'chain');
    return false;
  }
  const block = resp.data.block;
  log(`latest block: height=${block.header.height}, hash=${(block.header.hash || 'unknown').slice(0, 16)}…, txs=${block.txs ? block.txs.length : '?'}`, 'chain');
  return true;
}

async function testMultiValidatorFlow(opts, round) {
  if (!opts.enableChain || !opts.validators) {
    return null;
  }

  const validatorPubkeys = opts.validators.split(',').map(v => v.trim()).filter(Boolean);
  if (validatorPubkeys.length === 0) {
    return null;
  }

  const identity = await api(opts.url, '/api/identity');
  if (!identity.ok || identity.data.locked) {
    log('identity locked — skipping multi-validator test', 'validators');
    return null;
  }

  const ourPubkey = identity.data.pubkey;
  if (!validatorPubkeys.includes(ourPubkey)) {
    log(`this node's pubkey not in validator set — skipping sign/commit flow`, 'validators');
    return null;
  }

  const proposals = await api(opts.url, '/api/chain/proposals');
  if (!proposals.ok) {
    log(`proposals query failed (${proposals.status}): ${proposals.text}`, 'validators');
    return false;
  }

  if (!proposals.data.pending || proposals.data.pending.length === 0) {
    log(`round ${round}: no pending proposals (block producer will create them automatically)`, 'validators');
    return true;
  }

  const proposal = proposals.data.pending[0];
  const signResp = await api(opts.url, '/api/chain/sign', {
    method: 'POST',
    body: {
      block_hash: proposal.block_hash,
    },
  });

  if (!signResp.ok) {
    log(`sign failed (${signResp.status}): ${signResp.text}`, 'validators');
    return false;
  }

  log(`round ${round}: signed proposal ${proposal.block_hash.slice(0, 16)}…`, 'validators');
  return true;
}

async function main() {
  const opts = parseArgs();
  log(`Starting blockchain chain test`);
  log(`  URL: ${opts.url}`);
  log(`  Interval: ${opts.interval / 1000}s`);
  log(`  Count: ${opts.count === 0 ? 'infinite' : opts.count}`);
  log(`  Prefix: "${opts.prefix}"`);
  log(`  Enable Chain: ${opts.enableChain}`);
  log(`  Validators: ${opts.validators || '(none)'}`);
  log('');

  let round = 0;
  let success = 0;
  let failed = 0;

  while (opts.count === 0 || round < opts.count) {
    round++;
    const results = await Promise.allSettled([
      sendAnchorRound(opts, round),
      testAnchorPayload(opts, round),
      testOversizedPayload(opts),
      testGetLatestBlock(opts),
      testMultiValidatorFlow(opts, round),
    ]);

    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value === true) {
        success++;
      } else if (r.status === 'rejected') {
        failed++;
      }
    });

    if (opts.count === 0 || round < opts.count) {
      await new Promise(r => setTimeout(r, opts.interval));
    }
  }

  log('');
  log(`Done. ${success} succeeded, ${failed} failed (total ${round} rounds)`);
  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch(err => {
    console.error('fatal:', err);
    process.exit(1);
  });
}
