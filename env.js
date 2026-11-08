'use strict';
// Tiny zero-dependency .env loader. Loads ./.env from the project root.
// Never overrides variables already present in the real environment.
const fs = require('fs');
const path = require('path');

function loadEnv(dir) {
  const file = path.join(dir || __dirname, '.env');
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
  return true;
}

loadEnv(path.join(__dirname));
module.exports = { loadEnv };
