#!/usr/bin/env node
// Patches clawvault's stripQmdNoise to filter Warning: lines from qmd output
const fs = require('fs');
const path = require('path');

const CHUNK_NAME = 'chunk-6B3JWM7J.js';

// Search paths: local node_modules, /app Docker build, and global npm installs
const candidates = [
  path.join(__dirname, '..', 'node_modules', 'clawvault', 'dist', CHUNK_NAME),
  path.join('/app', 'node_modules', 'clawvault', 'dist', CHUNK_NAME),
  // Global npm install (Dockerfile.server uses npm install -g clawvault)
  path.join('/usr/local/lib/node_modules', 'clawvault', 'dist', CHUNK_NAME),
  path.join('/usr/lib/node_modules', 'clawvault', 'dist', CHUNK_NAME),
];

let chunkPath = null;
for (const p of candidates) {
  if (fs.existsSync(p)) {
    chunkPath = p;
    break;
  }
}

if (!chunkPath) {
  console.log('clawvault chunk not found in any known location, skipping patch');
  console.log('  searched:', candidates.join('\n           '));
  process.exit(0);
}

let src = fs.readFileSync(chunkPath, 'utf8');

const marker = 'if (t.startsWith("[node-llama-cpp]")) return false;';
const patch = `if (t.startsWith("[node-llama-cpp]")) return false;
    if (t.startsWith("Warning:")) return false;
    if (t.startsWith("No results found")) return false;`;

if (src.includes('if (t.startsWith("Warning:"))')) {
  console.log(`Already patched: ${chunkPath}`);
  process.exit(0);
}

if (!src.includes(marker)) {
  console.log(`Marker not found in ${chunkPath} — clawvault version may have changed`);
  process.exit(0);
}

src = src.replace(marker, patch);
fs.writeFileSync(chunkPath, src);
console.log(`Patched ${chunkPath}`);
