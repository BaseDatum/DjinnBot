#!/usr/bin/env node
// Fixes sqlite-vec double-.so bug with Bun's loadExtension()
// Bun auto-appends .so/.dylib/.dll, but sqlite-vec already includes it
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const vecIndex = execSync('find /root/.bun/install -name "index.mjs" -path "*/sqlite-vec/*" 2>/dev/null | head -1')
  .toString().trim();

if (!vecIndex) {
  console.log('sqlite-vec not found, skipping patch');
  process.exit(0);
}

let src = fs.readFileSync(vecIndex, 'utf8');
const original = 'db.loadExtension(getLoadablePath())';
const patched = 'db.loadExtension(getLoadablePath().replace(/\\.(so|dylib|dll)$/,""))';

if (src.includes(original)) {
  src = src.replace(original, patched);
  fs.writeFileSync(vecIndex, src);
  console.log(`Patched ${vecIndex}`);
} else {
  console.log('Already patched or load() signature changed');
}
