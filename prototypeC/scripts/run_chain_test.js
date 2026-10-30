#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const NODE_BIN = path.resolve(__dirname, '..', 'node', 'target', 'release', process.platform === 'win32' ? 'ddn-node.exe' : 'ddn-node');
const DEFAULT_HTTP_PORT = parseInt(process.env.DDN_HTTP_PORT || '3000', 10);
const DEFAULT_P2P_PORT = parseInt(process.env.DDN_P2P_PORT || '4001', 10);
const DATA_DIR = process.env.DDN_DATA_DIR || path.join(os.tmpdir(), 'ddn-chain-test');
const KEEP_RUNNING = process.argv.includes('--keep-running');
const OPEN_BROWSER = !process.argv.includes('--no-browser');

function log(msg) {
  console.log(`[chain-runner] ${msg}`);
}

function fetchJson(url) {
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const result = spawnSync(curl, ['-s', url], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function getIdentity(port) {
  return fetchJson(`http://127.0.0.1:${port}/api/identity`);
}

function waitForIdentity(port, timeoutMs) {
  timeoutMs = timeoutMs || 30000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const identity = getIdentity(port);
    if (identity && identity.pubkey) {
      return identity.pubkey;
    }
    const end = Date.now() + 500;
    while (Date.now() < end) {}
  }
  return null;
}

function sleepMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

function startNode(label, port, p2pPort, dataDir, extraEnv) {
  log(`Starting node[${label}] (HTTP :${port}, P2P :${p2pPort}, data=${dataDir})...`);
  const child = spawn(NODE_BIN, [], {
    env: { ...process.env, DDN_HTTP_PORT: String(port), DDN_P2P_PORT: String(p2pPort), DDN_DATA_DIR: dataDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (data) => {
    const text = data.toString().trim();
    if (text) log(`[node:${label}] ${text}`);
  });
  child.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text) log(`[node-err:${label}] ${text}`);
  });

  return child;
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
  spawnSync(cmd, { shell: true, stdio: 'ignore' });
  log(`Opened browser: ${url}`);
}

function runChainTest(port, validators) {
  log(`Running chain_test.js with validators: ${validators}`);
  const result = spawnSync('node', [
    path.resolve(__dirname, 'chain_test.js'),
    '--url', `http://127.0.0.1:${port}`,
    '--enable-chain',
    '--validators', validators,
  ], { stdio: 'inherit' });

  return result.status === 0;
}

function connectPeers(fromPort, toPort) {
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
  spawnSync(curl, ['-s', '-X', 'POST', `http://127.0.0.1:${fromPort}/api/peers`, '-H', 'Content-Type: application/json', '-d', JSON.stringify({ url: `http://127.0.0.1:${toPort}` })], { encoding: 'utf8', timeout: 5000 });
}

function main() {
  if (!fs.existsSync(NODE_BIN)) {
    log(`ERROR: Node binary not found at ${NODE_BIN}`);
    log('Build it first: cd prototypeC/node && cargo build --release');
    process.exit(1);
  }

  const multiValidator = process.argv.includes('--multi');
  const validatorCount = parseInt(process.env.DDN_VALIDATORS_COUNT || '3', 10);

  if (multiValidator) {
    log(`Multi-validator mode: starting ${validatorCount} nodes on separate ports...`);

    const nodeConfigs = [];
    for (let i = 0; i < validatorCount; i++) {
      nodeConfigs.push({
        label: `v${i}`,
        httpPort: DEFAULT_HTTP_PORT + 10 + i,
        p2pPort: DEFAULT_P2P_PORT + 10 + i,
        dataDir: path.join(DATA_DIR, `multi-validator-${i}`),
      });
    }

    log('Phase 1: Starting nodes to generate identities...');
    const nodes = [];
    for (const cfg of nodeConfigs) {
      const child = startNode(cfg.label, cfg.httpPort, cfg.p2pPort, cfg.dataDir);
      nodes.push({ ...cfg, child });
    }

    log('Waiting for all nodes to generate identities...');
    const pubkeys = [];
    for (const node of nodes) {
      const pubkey = waitForIdentity(node.httpPort, 30000);
      if (!pubkey) {
        log(`ERROR: Node ${node.label} did not start`);
        nodes.forEach(n => n.child.kill());
        process.exit(1);
      }
      pubkeys.push(pubkey);
      log(`Node ${node.label} pubkey: ${pubkey.slice(0, 24)}…`);
    }

    log('Stopping nodes to restart with chain + validator set...');
    nodes.forEach(n => n.child.kill());

    const validatorsStr = pubkeys.join(',');
    log(`Validator set: ${pubkeys.map(p => p.slice(0, 12) + '…').join(', ')}`);

    log('Phase 2: Restarting nodes with DDN_ENABLE_CHAIN=1...');
    sleepMs(1000);

    const restarted = nodes.map(n => ({
      ...n,
      child: startNode(n.label, n.httpPort, n.p2pPort, n.dataDir, {
        DDN_ENABLE_CHAIN: '1',
        DDN_VALIDATORS: validatorsStr,
      }),
    }));

    log('Waiting for all nodes to be ready with chain...');
    for (const node of restarted) {
      const pk = waitForIdentity(node.httpPort, 30000);
      if (!pk) {
        log(`ERROR: Node ${node.label} did not start with chain`);
        restarted.forEach(n => { try { n.child.kill(); } catch {} });
        process.exit(1);
      }
    }

    log('Phase 3: Connecting nodes as peers...');
    for (let i = 1; i < restarted.length; i++) {
      connectPeers(restarted[0].httpPort, restarted[i].httpPort);
    }

    if (OPEN_BROWSER) {
      log('Opening browser windows...');
      openBrowser(`http://127.0.0.1:${DEFAULT_HTTP_PORT + 10}/api/chain/block/latest`);
      for (let i = 1; i < restarted.length; i++) {
        openBrowser(`http://127.0.0.1:${DEFAULT_HTTP_PORT + 10 + i}/api/chain/block/latest`);
      }
    }

    const ok = runChainTest(restarted[0].httpPort, validatorsStr);

    if (KEEP_RUNNING) {
      log('\n=== Nodes still running (Ctrl+C to stop) ===');
      restarted.forEach(n => {
        log(`  ${n.label}: http://127.0.0.1:${n.httpPort}`);
      });
      process.stdin.resume();
    } else {
      log('Cleaning up: stopping all nodes...');
      restarted.forEach(n => { try { n.child.kill(); } catch {} });
    }

    process.exit(ok ? 0 : 1);
  } else {
    log('Single-validator mode: starting node, fetching pubkey, restarting with chain...');

    const env1 = {
      DDN_HTTP_PORT: String(DEFAULT_HTTP_PORT),
      DDN_P2P_PORT: String(DEFAULT_P2P_PORT),
      DDN_DATA_DIR: DATA_DIR,
    };

    const node1 = startNode('node', DEFAULT_HTTP_PORT, DEFAULT_P2P_PORT, DATA_DIR);
    log('Waiting for identity generation...');
    const pubkey = waitForIdentity(DEFAULT_HTTP_PORT, 30000);
    if (!pubkey) {
      log('ERROR: Node did not start');
      node1.kill();
      process.exit(1);
    }
    log(`Node pubkey: ${pubkey.slice(0, 24)}…`);
    node1.kill();
    sleepMs(1000);

    log(`Restarting with DDN_ENABLE_CHAIN=1 DDN_VALIDATORS="${pubkey}"...`);
    const env2 = { ...env1, DDN_ENABLE_CHAIN: '1', DDN_VALIDATORS: pubkey };
    const node2 = startNode('node', DEFAULT_HTTP_PORT, DEFAULT_P2P_PORT, DATA_DIR, {
      DDN_ENABLE_CHAIN: '1',
      DDN_VALIDATORS: pubkey,
    });

    waitForIdentity(DEFAULT_HTTP_PORT, 30000);

    if (OPEN_BROWSER) {
      openBrowser(`http://127.0.0.1:${DEFAULT_HTTP_PORT}/api/chain/block/latest`);
    }

    const ok = runChainTest(DEFAULT_HTTP_PORT, pubkey);
    log(ok ? 'All tests passed!' : 'Tests failed (see output above).');

    if (KEEP_RUNNING) {
      log(`\nNode still running at http://127.0.0.1:${DEFAULT_HTTP_PORT} (Ctrl+C to stop)`);
      process.stdin.resume();
    } else {
      node2.kill();
    }

    process.exit(ok ? 0 : 1);
  }
}

main();
