#!/usr/bin/env node
// Patches clawvault's stripQmdNoise to filter Warning: lines from qmd output
const fs = require('fs');
const path = require('path');

// Try relative to script (local dev) or /app (Docker build)
let chunkPath = path.join(__dirname, '..', 'node_modules', 'clawvault', 'dist', 'chunk-6B3JWM7J.js');
if (!fs.existsSync(chunkPath)) {
  chunkPath = '/app/node_modules/clawvault/dist/chunk-6B3JWM7J.js';
}

if (!fs.existsSync(chunkPath)) {
  console.log('clawvault chunk not found, skipping patch');
  process.exit(0);
}

let src = fs.readFileSync(chunkPath, 'utf8');

const marker = 'if (t.startsWith("[node-llama-cpp]")) return false;';
const patch = `if (t.startsWith("[node-llama-cpp]")) return false;
    if (t.startsWith("Warning:")) return false;
    if (t.startsWith("No results found")) return false;`;

if (src.includes('if (t.startsWith("Warning:"))')) {
  console.log('Already patched');
  process.exit(0);
}

if (!src.includes(marker)) {
  console.log('Marker not found in clawvault chunk — version may have changed');
  process.exit(0);
}

src = src.replace(marker, patch);
fs.writeFileSync(chunkPath, src);
console.log(`Patched ${chunkPath}`);
