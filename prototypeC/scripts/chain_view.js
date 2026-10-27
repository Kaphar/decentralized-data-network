#!/usr/bin/env node
'use strict';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    url: 'http://127.0.0.1:3000',
    start: 0,
    end: null,
    watch: false,
    interval: 5,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url':
      case '-u':
        opts.url = args[++i];
        break;
      case '--start':
        opts.start = parseInt(args[++i], 10);
        break;
      case '--end':
        opts.end = parseInt(args[++i], 10);
        break;
      case '--watch':
      case '-w':
        opts.watch = true;
        break;
      case '--interval':
      case '-i':
        opts.interval = parseInt(args[++i], 10);
        break;
      case '--help':
      case '-h':
        console.log(`Usage: node chain_view.js [options]

Options:
  --url, -u <url>    Node API URL (default: http://127.0.0.1:3000)
  --start <n>       Start block height (default: 0)
  --end <n>         End block height (default: latest)
  --watch, -w       Continuously refresh
  --interval, -i <n>  Refresh interval in seconds (default: 5)`);
        process.exit(0);
    }
  }
  return opts;
}

function trunc(s, n = 12) {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, 6) + '…' + s.slice(-6);
}

function fmtTime(ts) {
  if (ts === 0) return 'genesis';
  return new Date(ts * 1000).toISOString();
}

async function fetchJSON(url, path) {
  const resp = await fetch(`${url}${path}`);
  if (!resp.ok) return null;
  return resp.json();
}

async function fetchLatestBlock(url) {
  return fetchJSON(url, '/api/chain/block/latest');
}

async function fetchBlock(url, height) {
  return fetchJSON(url, `/api/chain/block/${height}`);
}

function renderBlock(b) {
  if (!b || !b.header) return '  (block not found)';
  const h = b.header;
  const lines = [];
  lines.push(`  ┌── Block ${h.height}  hash=${trunc(h.hash, 14)}  props=${trunc(h.proposer)}  ${fmtTime(h.timestamp)}`);
  lines.push(`  │   parent=${trunc(h.parent_hash, 14)}  root=${trunc(h.merkle_root, 14)}  nonce=${h.nonce}`);
  if (b.txs && b.txs.length > 0) {
    lines.push(`  │   txs (${b.txs.length}):`);
    for (const tx of b.txs) {
      lines.push(`  │     • cid=${trunc(tx.record_cid, 14)}  author=${trunc(tx.author)}  ts=${tx.ts}  sig=${trunc(tx.sig, 14)}`);
    }
  } else {
    lines.push('  │   txs: (empty)');
  }
  lines.push(`  └──`);
  return lines.join('\n');
}

async function renderChain(opts) {
  const { url, start, end, watch } = opts;

  const latest = await fetchLatestBlock(url);
  if (!latest || !latest.block) {
    console.log('Cannot fetch latest block — is the node running with DDN_ENABLE_CHAIN=1?');
    return;
  }

  const latestHeight = latest.block.header.height;
  const maxEnd = end !== null ? Math.min(end, latestHeight) : latestHeight;

  const validators = await fetchJSON(url, '/api/chain/validators');
  const vals = validators && validators.validators ? validators.validators : [];

  console.clear();
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  DDN Anchor Chain — Blockchain Viewer                     ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`Node: ${url}`);
  console.log(`Latest: block ${latestHeight} (hash: ${trunc(latest.block.header.hash, 14)})`);
  console.log(`Validators: ${vals.map(trunc).join(', ')}`);
  console.log('');

  if (latestHeight === 0) {
    console.log('Chain has only the genesis block.');
  } else {
    const hi = start;
    const lo = Math.max(start, maxEnd);

    for (let h = lo; h >= hi; h--) {
      const blockData = await fetchBlock(url, h);
      if (blockData && blockData.block) {
        console.log(renderBlock(blockData.block));
      } else {
        console.log(`  ┌── Block ${h}`);
        console.log('  │   (not found)');
        console.log('  └──');
      }
      console.log('');
    }
  }

  if (watch) {
    console.log(`Auto-refresh every ${opts.interval}s (Ctrl+C to exit)`);
  }
}

async function main() {
  const opts = parseArgs();

  if (opts.watch) {
    while (true) {
      await renderChain(opts).catch(e => console.error('error:', e.message));
      await new Promise(r => setTimeout(r, opts.interval * 1000));
    }
  } else {
    await renderChain(opts).catch(e => {
      console.error('error:', e.message);
      process.exit(1);
    });
  }
}

if (require.main === module) {
  main();
}
