#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const nodeDir = path.join(root, 'node');
const frontendDir = path.join(root, 'frontend');

function log(msg) {
  console.log(`[prototypeC] ${msg}`);
}

function buildNode() {
  log('building ddn-node sidecar (cargo build --release)...');
  execSync('cargo build --release', { cwd: nodeDir, stdio: 'inherit' });
  log('sidecar built.');
}

function buildFrontend() {
  const dist = path.join(frontendDir, 'dist', 'index.html');
  if (fs.existsSync(dist)) {
    log('frontend dist exists, skipping build.');
    return;
  }
  log('building frontend (npm run build)...');
  execSync('npm run build', { cwd: frontendDir, stdio: 'inherit' });
}

function linkSources() {
  const srcNode = path.resolve(root, '..', 'prototypeB', 'node');
  const srcFrontend = path.resolve(root, '..', 'prototypeB', 'frontend');
  if (!fs.existsSync(nodeDir)) {
    fs.symlinkSync(srcNode, nodeDir, 'dir');
    log(`linked node -> ${srcNode}`);
  }
  if (!fs.existsSync(frontendDir)) {
    fs.symlinkSync(srcFrontend, frontendDir, 'dir');
    log(`linked frontend -> ${srcFrontend}`);
  }
}

function runDev() {
  buildNode();
  buildFrontend();
  log('starting Tauri dev shell...');
  execSync('cargo tauri dev', { cwd: root, stdio: 'inherit' });
}

function runBuild() {
  buildNode();
  buildFrontend();
  log('building Tauri bundle...');
  execSync('cargo tauri build', { cwd: root, stdio: 'inherit' });
}

const args = process.argv.slice(2);
switch (args[0]) {
  case 'link':
    linkSources();
    break;
  case 'build':
    runBuild();
    break;
  case 'dev':
  default:
    runDev();
    break;
}
