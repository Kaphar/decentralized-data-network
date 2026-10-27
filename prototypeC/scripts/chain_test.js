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
    }
  }
  return opts;
}

function log(msg, tag = '') {
  const ts = new Date().toISOString();
  const prefix = tag ? `[${tag}]` : '[test]';
  console.log(`${ts} ${prefix} ${msg}`);
}

async function api(path, opts = {}) {
  const resp = await fetch(`${opts.url}${path}`, {
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
  const identity = await api('/api/identity', { url: opts.url });
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

  const signed = await api('/api/record/sign', {
    url: opts.url,
    method: 'POST',
    body: { type: 'post', author: pubkey, prev: null, ts, payload },
  });
  if (!signed.ok) {
    log(`sign failed (${signed.status}): ${signed.text}`, 'record');
    return false;
  }

  const submitted = await api('/api/record', {
    url: opts.url,
    method: 'POST',
    body: signed.data,
  });
  if (!submitted.ok) {
    log(`submit failed (${submitted.status}): ${submitted.text}`, 'record');
    return false;
  }
  const recordId = submitted.data.id;

  const anchored = await api('/api/chain/anchor', {
    url: opts.url,
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

async function main() {
  const opts = parseArgs();
  log(`Starting blockchain anchor test loop`);
  log(`  URL: ${opts.url}`);
  log(`  Interval: ${opts.interval / 1000}s`);
  log(`  Count: ${opts.count === 0 ? 'infinite' : opts.count}`);
  log(`  Prefix: "${opts.prefix}"`);
  log('');

  let round = 0;
  let success = 0;
  let failed = 0;

  while (opts.count === 0 || round < opts.count) {
    round++;
    if (await sendAnchorRound(opts, round)) {
      success++;
    } else {
      failed++;
    }

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
