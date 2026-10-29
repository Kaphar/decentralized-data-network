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

  function ensureCopied(src, dest) {
    if (fs.existsSync(dest) && !fs.lstatSync(dest).isSymbolicLink()) {
      log(`already copied: ${dest}`);
      return;
    }
    if (fs.lstatSync(dest).isSymbolicLink()) {
      fs.unlinkSync(dest);
    }
    if (!fs.existsSync(src)) {
      log(`ERROR: source not found: ${src}`);
      process.exit(1);
    }
    fs.cpSync(src, dest, { recursive: true });
    log(`copied ${src} -> ${dest}`);
  }

  if (!fs.existsSync(nodeDir) || fs.lstatSync(nodeDir).isSymbolicLink()) {
    ensureCopied(srcNode, nodeDir);
  }
  if (!fs.existsSync(frontendDir) || fs.lstatSync(frontendDir).isSymbolicLink()) {
    ensureCopied(srcFrontend, frontendDir);
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
