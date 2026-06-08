'use strict';

// Local app profile. This is intentionally separate from ~/.routerrc, which
// carries the Router key/server identity.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.router-daybook');
const PROFILE_FILE = path.join(DIR, 'profile.json');

function ensureDir() { try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* ignore */ } }

function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function loadProfile() {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')); }
  catch { return { version: 1, name: '' }; }
  if (!parsed || typeof parsed !== 'object') return { version: 1, name: '' };
  return { version: 1, name: cleanName(parsed.name) };
}

function saveProfile(profile) {
  ensureDir();
  const out = { version: 1, name: cleanName(profile && profile.name) };
  try {
    const tmp = PROFILE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, PROFILE_FILE);
  } catch {
    try { fs.writeFileSync(PROFILE_FILE, JSON.stringify(out, null, 2)); } catch { /* ignore */ }
  }
  return out;
}

function setName(name) {
  return saveProfile({ ...loadProfile(), name: cleanName(name) });
}

module.exports = { loadProfile, saveProfile, setName, cleanName, PROFILE_FILE };
