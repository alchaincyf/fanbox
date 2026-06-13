'use strict';

const fs = require('fs');
const path = require('path');

if (process.platform === 'win32') process.exit(0);

const root = path.join(__dirname, '..');
const candidates = [
  path.join(root, 'node_modules', 'node-pty', 'build', 'Release', 'spawn-helper'),
  path.join(root, 'node_modules', 'node-pty', 'prebuilds'),
];

function chmodExecutable(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return;
    const nextMode = st.mode | 0o755;
    if ((st.mode & 0o111) === 0o111) return;
    fs.chmodSync(file, nextMode);
    console.log(`[fanbox] fixed executable bit: ${path.relative(root, file)}`);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.warn(`[fanbox] could not chmod ${path.relative(root, file)}: ${err.message}`);
    }
  }
}

for (const candidate of candidates) {
  if (!fs.existsSync(candidate)) continue;
  const st = fs.statSync(candidate);
  if (st.isFile()) {
    chmodExecutable(candidate);
    continue;
  }
  for (const dir of fs.readdirSync(candidate)) {
    chmodExecutable(path.join(candidate, dir, 'spawn-helper'));
  }
}
