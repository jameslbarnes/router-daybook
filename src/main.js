'use strict';

const { app, BrowserWindow, ipcMain, shell, nativeImage, dialog } = require('electron');
app.setName('Teleport Router');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');

const { collectToday, collectSinceLastPost, collectRecent, collectMostRecentDay, claudeDirToPath } = require('./transcripts');
const { generate, extractPatterns } = require('./reflect');
const scopeMod = require('./scope');
const { redact } = require('./redact');
const { post, fetchFeed, cohortFeed, lastOwnPostMs, postStreak, whoami, loadConfig, hasConfig, joinWithInvite, useExistingKey, DEFAULT_SERVER } = require('./router');
const learning = require('./preferences');
const intro = require('./intro');
const link = require('./link');
const profile = require('./profile');

let win;
let session = {};  // last digest generation's inputs, reused for in-place revision
let introCtx = {}; // onboarding context (history/projects/feed), reused across intro steps

// Whose day is this? Third-person voice needs a subject name.
// The user's FIRST name is preferred, sourced from DAYBOOK_NAME, local Settings,
// then ~/.routerrc `name`; first token only. If none is configured, stay neutral.
function firstNameOf(s) { return String(s || '').trim().split(/\s+/)[0] || ''; }
function resolveName() {
  let raw = process.env.DAYBOOK_NAME || '';
  if (!raw) raw = profile.loadProfile().name || '';
  if (!raw) {
    try { raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.routerrc'), 'utf8')).name || ''; }
    catch { /* ignore */ }
  }
  return firstNameOf(raw) || 'the author';
}

function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 880,
    minWidth: 560,
    minHeight: 640,
    title: 'Teleport Router',
    backgroundColor: '#0e0b1a',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Allow microphone for the voice-answer feature (local transcription only).
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media');
  });
}

// Resolve a binary, preferring known Homebrew / local paths over bare PATH.
function resolveBin(candidates) {
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* skip */ } }
  return candidates[candidates.length - 1];
}
const FFMPEG = resolveBin(['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg']);
const UVX = resolveBin([path.join(os.homedir(), '.local/bin/uvx'), '/opt/homebrew/bin/uvx', 'uvx']);
const UV = resolveBin([path.join(os.homedir(), '.local/bin/uv'), '/opt/homebrew/bin/uv', 'uv']);

// ── persistent MLX-Whisper sidecar (model stays resident) ─────────────────
let whisper = null;
let whisperReqId = 0;
function ensureWhisper() {
  if (whisper) return whisper.ready;
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  let proc;
  try {
    proc = spawn(UV, ['run', '--python', '3.12', '--with', 'mlx-whisper', 'python', path.join(__dirname, 'whisper_server.py')],
      { env: { ...process.env, ANTHROPIC_API_KEY: '' } });
  } catch { return Promise.resolve(); }
  whisper = { proc, ready, pending: new Map(), buf: '' };
  proc.stdout.on('data', (d) => {
    whisper.buf += d.toString();
    let i;
    while ((i = whisper.buf.indexOf('\n')) >= 0) {
      const line = whisper.buf.slice(0, i); whisper.buf = whisper.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.type === 'ready') resolveReady();
      else if (m.id && whisper.pending.has(m.id)) { whisper.pending.get(m.id)(m.text || ''); whisper.pending.delete(m.id); }
    }
  });
  proc.on('close', () => { whisper = null; });
  proc.on('error', () => { whisper = null; });
  return ready;
}
async function transcribeViaSidecar(wavPath) {
  await ensureWhisper();
  if (!whisper) return '';
  const id = String(++whisperReqId);
  return new Promise((resolve) => {
    whisper.pending.set(id, resolve);
    try { whisper.proc.stdin.write(JSON.stringify({ id, path: wavPath }) + '\n'); }
    catch { resolve(''); }
  });
}

// ── disco-ball dock icon ──────────────────────────────────────────────────
function generateIcon(outPath) {
  return new Promise((resolve) => {
    let w;
    try {
      w = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true,
        webPreferences: { offscreen: true } });
    } catch { return resolve(false); }
    const done = (ok) => { try { w.destroy(); } catch { /* */ } resolve(ok); };
    w.loadFile(path.join(__dirname, '..', 'renderer', 'icon.html'));
    w.webContents.once('did-finish-load', () => setTimeout(async () => {
      try {
        const img = await w.webContents.capturePage();
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, img.toPNG());
        done(true);
      } catch { done(false); }
    }, 500));
    setTimeout(() => done(false), 4000);
  });
}

async function ensureDockIcon() {
  if (!app.dock) return; // macOS only
  const iconPath = path.join(__dirname, '..', 'assets', 'disco.png');
  try {
    if (!fs.existsSync(iconPath)) await generateIcon(iconPath);
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) app.dock.setIcon(img);
  } catch { /* keep default */ }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { env: { ...process.env, ANTHROPIC_API_KEY: '' } });
    let err = '';
    c.stderr.on('data', (d) => { err += d.toString(); });
    c.on('error', reject);
    c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.slice(-300)}`))));
  });
}

// ── IPC: transcribe a recorded answer LOCALLY (ffmpeg → MLX Whisper) ───────
ipcMain.handle('transcribe-audio', async (_evt, { base64 }) => {
  if (!base64) return '';
  const id = 'daybook-ans-' + Date.now();
  const inPath = path.join(os.tmpdir(), id + '.webm');
  const wavPath = path.join(os.tmpdir(), id + '.wav');
  const txtPath = path.join(os.tmpdir(), id + '.txt');
  try {
    fs.writeFileSync(inPath, Buffer.from(base64, 'base64'));
    await run(FFMPEG, ['-y', '-i', inPath, '-ar', '16000', '-ac', '1', wavPath]);
    return await transcribeViaSidecar(wavPath); // resident model — fast after warmup
  } finally {
    for (const p of [inPath, wavPath, txtPath]) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  }
});

// Pre-warm the Whisper model so the first spoken answer transcribes fast.
ipcMain.handle('warm-whisper', async () => { ensureWhisper(); return { ok: true }; });

// ── IPC: first-run check + identity (decides onboarding vs digest) ────────
ipcMain.handle('bootstrap', async () => {
  const name = resolveName();
  const hasKey = hasConfig();
  let handle = null, server = DEFAULT_SERVER, configError = null;
  try { server = loadConfig().server; } catch (e) { configError = e.message; }
  if (hasKey) { try { const who = await whoami(); handle = who && who.handle; } catch { /* offline */ } }
  return { hasKey, introduced: intro.isIntroduced(), name, handle, server, configError };
});

ipcMain.handle('settings:get', async () => {
  const p = profile.loadProfile();
  return { name: p.name || '', effectiveName: resolveName() };
});

ipcMain.handle('settings:setName', async (_evt, { name } = {}) => {
  const p = profile.setName(name);
  return { name: p.name || '', effectiveName: resolveName() };
});

// In-app "Connect to the Router": parse an invite link/code, join, save rc.
ipcMain.handle('join', async (_evt, { invite, handle }) => {
  let server = DEFAULT_SERVER, inviteCode = (invite || '').trim();
  try {
    const u = new URL(invite);                        // a full /register?invite=… link
    server = u.origin;
    inviteCode = u.searchParams.get('invite') || u.searchParams.get('code') || inviteCode;
  } catch { /* not a URL — treat the input as a bare code on the default server */ }
  return await joinWithInvite({ server, inviteCode, handle });
});

// Already have a key (router CLI, another machine)? Paste it instead of joining.
ipcMain.handle('use-key', async (_evt, { key } = {}) => useExistingKey({ key }));

// ── IPC: onboarding — discover projects, draft the intro, mark done ────────
ipcMain.handle('discover-projects', async () => intro.discoverProjects());

// Step 1: read history → the opening interview question.
ipcMain.handle('intro-start', async () => {
  const name = resolveName();
  let handle = null, feedEntries = [];
  try { const who = await whoami(); handle = who && who.handle; } catch { /* offline */ }
  try { const f = await fetchFeed({ days: 30, limit: 40 }); if (f.ok) feedEntries = f.entries; } catch { /* feedless */ }
  const projects = await intro.discoverProjects();
  const history = await collectRecent(30);
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  introCtx = { name, handle, projects, history: history.digest, feedEntries, projectCount: history.projectCount || projects.length, stamp };
  const q = await intro.firstQuestion({ name, projects, history: history.digest, feedEntries });
  return { ...q, projectCount: introCtx.projectCount };
});

// Push the live token count to the renderer's "thinking" view.
function streamTokens() {
  return (_text, tokens) => { if (win) win.webContents.send('gen-stream', { tokens }); };
}

// Step 2: a natural follow-up given the conversation so far (or done).
ipcMain.handle('intro-next', async (_evt, { transcript }) => {
  if (!introCtx.name) throw new Error('Start the intro first.');
  return await intro.nextQuestion({ ...introCtx, transcript: transcript || [], timeoutMs: 60000, onChunk: streamTokens() });
});

// Step 3: write the full intro from the interview transcript.
ipcMain.handle('intro-write', async (_evt, { transcript }) => {
  if (!introCtx.name) throw new Error('Start the intro first.');
  const res = await intro.generateIntro({ ...introCtx, interview: transcript || [], onChunk: streamTokens() });
  // Persist the interview + the intro it produced to interviews/<stamp>.md.
  intro.saveInterview({
    transcript: transcript || [], post: res.post,
    name: introCtx.name, handle: introCtx.handle, stamp: introCtx.stamp,
  });
  return { ...res, projectCount: introCtx.projectCount };
});

ipcMain.handle('mark-introduced', async () => { intro.markIntroduced(); return { ok: true }; });

// The full welcome message — one natural note grounded in the most recent day's
// actual work (the same source the daily digest uses), not guessed.
ipcMain.handle('welcome-message', async () => {
  const name = resolveName();
  const r = await collectMostRecentDay();
  return { message: await intro.welcomeMessage({ name, recent: r.digest, dayLabel: r.date }) };
});

// ── IPC: gather today's activity + resolve the venue ──────────────────────
ipcMain.handle('collect', async () => {
  const scope = scopeMod.loadScope();
  // Anchor the window to your last Router post (the Router records every post
  // with a date, so this is correct on any machine without a local marker).
  // Unreachable feed → null → collectSinceLastPost falls back to the last 7 days.
  let lastPostMs = null;
  try { lastPostMs = await lastOwnPostMs(); } catch { /* offline → fallback */ }
  const result = await collectSinceLastPost(scope, lastPostMs);
  let server = DEFAULT_SERVER;
  let configError = null;
  try {
    server = loadConfig().server;
  } catch (e) {
    configError = e.message;
  }

  // Fold in any saved SSH machines' work — so a linked computer's folders show
  // up in today's digest automatically. Pulled in parallel; unreachable peers
  // are skipped quietly (one ~10s timeout total, not per-peer-serial).
  let digest = result.digest;
  let hasActivity = result.hasActivity;
  let projectCount = result.stats.projectCount;
  const results = await Promise.all(link.listPeers().map((p) => link.collectPeerToday(p.target)));
  const peers = [];
  for (const r of results) {
    if (r.ok && r.projectCount > 0) {
      digest += `\n\n=== ALSO ON ${r.target} (linked over SSH) ===\n${r.digest}`;
      hasActivity = true;
      projectCount += r.projectCount;
      peers.push({ target: r.target, projectCount: r.projectCount, projects: r.projects, truncated: r.truncated });
    } else if (r.ok) {
      peers.push({ target: r.target, projectCount: 0 });
    } else {
      peers.push({ target: r.target, error: r.error });
    }
  }
  const stats = { ...result.stats, projectCount };

  return { ...result, digest, hasActivity, stats, peers, name: resolveName(), server, configError };
});

// ── IPC: read cohort feed + generate the structured digest ────────────────
ipcMain.handle('generate', async (_evt, { digest, name, dateLabel }) => {
  if (!digest || !digest.trim()) throw new Error('Nothing to reflect on yet today.');

  // Read the cohort feed for collaboration matching. If it fails, we still
  // generate — the "Open to" section just falls back to an open ask.
  let feedEntries = [];
  let feedError = null;
  let myHandle = null;
  try {
    const feed = await fetchFeed({ days: 14, limit: 60 });
    if (feed.ok) { feedEntries = feed.entries; myHandle = feed.myHandle; }
    else feedError = feed.error;
  } catch (e) {
    feedError = e.message;
  }

  // Re-derive recurring patterns from the notes log if it has grown since last
  // time, then apply only those distilled patterns (never raw one-off notes).
  if (learning.shouldDerive()) {
    try {
      const patterns = await extractPatterns(learning.notesWindow(), { name });
      learning.savePatterns(learning.readNotes().length, patterns);
    } catch { /* keep prior cache */ }
  }
  const learned = learning.learned();

  // Cache this run so a follow-up revision reuses the same feed/digest/identity.
  session = { digest, name, dateLabel, feedEntries, myHandle, standingPreferences: learned.text };

  const result = await generate(digest, { name, dateLabel, feedEntries, myHandle, standingPreferences: learned.text });
  return { ...result, feedCount: feedEntries.length, feedError, myHandle, learned: learned.patterns };
});

// ── IPC: revise THE CURRENT draft in place; the note is logged silently ────
ipcMain.handle('revise', async (_evt, { currentDraft, instruction }) => {
  if (!instruction || !instruction.trim()) throw new Error('Tell me what to change.');
  if (!session.digest) throw new Error('Nothing to revise yet.');
  // Log the note (it only ever matters if it later becomes a pattern), then
  // apply it to THIS draft only.
  learning.recordNote(instruction.trim(), session.dateLabel);
  const result = await generate(session.digest, { ...session, currentDraft, instruction });
  return { ...result, learned: learning.learned().patterns };
});

// ── IPC: OPTIONAL "refine in interview" — reuse the onboarding interview
// engine to sharpen the CURRENT daily draft. Same firstQuestion/nextQuestion
// loop (intro.js), but with a refine purpose grounded in the draft. The answers
// become a single revise instruction fed to the SAME generate() revise path, so
// every safety scrub still runs. Default daily flow is untouched; this only
// runs when the user clicks the button.
const REFINE_PURPOSE = (name) => `This is a SHORT interview to help ${name} sharpen the daily-update draft below before he shares it with the cohort. You are NOT re-interviewing him about who he is — you are helping THIS draft. Find what he most wants to get across, or most wants to hear back from the cohort, that the draft is missing, overstating, or framing wrong. Aim at substance and at what would make the post more useful to him and to readers.`;
const REFINE_OPENING = `Ask the FIRST question. Read the current draft and ask the single most useful thing that would sharpen it — what he most wants the cohort to know or respond to, what feels off or missing, or whether the ask (if there is one) is the thing he actually wants help with. One question, grounded in the draft.`;
const REFINE_GOALS = `Over at most two or three questions, surface: what he most wants to land or get back from the cohort; anything the draft overstates, misses, or frames wrong; and whether the ask is the high-value one (or should change or drop). Keep it short, then end.`;

ipcMain.handle('refine:start', async (_evt, { draft } = {}) => {
  if (!session.digest) throw new Error('Generate a draft first.');
  const name = resolveName();
  return await intro.firstQuestion({
    name,
    history: session.digest,
    feedEntries: session.feedEntries || [],
    purpose: REFINE_PURPOSE(name),
    opening: REFINE_OPENING,
    focus: draft || '',
  });
});

ipcMain.handle('refine:next', async (_evt, { transcript, draft } = {}) => {
  if (!session.digest) throw new Error('Generate a draft first.');
  const name = resolveName();
  return await intro.nextQuestion({
    name,
    history: session.digest,
    feedEntries: session.feedEntries || [],
    transcript: transcript || [],
    maxTurns: 3,
    purpose: REFINE_PURPOSE(name),
    goals: REFINE_GOALS,
    focus: draft || '',
    timeoutMs: 60000,
    onChunk: streamTokens(),
  });
});

ipcMain.handle('refine:write', async (_evt, { transcript, draft } = {}) => {
  if (!session.digest) throw new Error('Generate a draft first.');
  const qa = (transcript || []).filter((t) => t && (t.a || '').trim());
  if (!qa.length) throw new Error('Nothing from the interview to apply.');
  const instruction = [
    'Refine the draft using what the author said in this short interview. Apply his intent — what he wants to land or get back, and any framing he corrected — while keeping everything that already works and obeying all the rules and the format.',
    '',
    qa.map((t, i) => `Q${i + 1}: ${t.q}\nA${i + 1}: ${t.a.trim()}`).join('\n\n'),
  ].join('\n');
  const result = await generate(session.digest, { ...session, currentDraft: draft || '', instruction });
  return { ...result, learned: learning.learned().patterns };
});

// ── IPC: view / forget what Router has learned ───────────────────────────
ipcMain.handle('get-learned', async () => learning.learned().patterns);
ipcMain.handle('clear-learned', async () => { learning.clearAll(); return { ok: true }; });

// ── IPC: post the approved digest to the cohort Router ────────────────────
// I2 final hop: re-scrub the EXACT outgoing bytes here, after the user may have
// hand-edited the draft following scrub #2. Without this, a secret/client name
// typed or pasted into the draft post-preview would egress verbatim. redact()
// is idempotent (block masks are guarded; client abstractions are protected
// against re-substitution in redact.js), so an unedited twice-scrubbed draft
// passing through is a true no-op. Runs the SAME rules as both prior scrubs.
ipcMain.handle('post', async (_evt, content) => {
  const { masked } = redact(content, scopeMod.loadRules());
  // No local bookkeeping needed: the post lands on the Router with a timestamp,
  // and the next collect reads it back via lastOwnPostMs as the new anchor.
  return await post(masked);
});

// ── Device link (peer-to-peer) ────────────────────────────────────────────
ipcMain.handle('link-host-start', async (_evt, { perms } = {}) => {
  return await link.startHost({
    perms: perms || { recent: true, raw: false },
    onChange: (info) => { if (win) win.webContents.send('link-host-changed', info); },
  });
});
ipcMain.handle('link-host-stop', async () => { link.stopHost(); return { ok: true }; });
ipcMain.handle('link-host-info', async () => link.hostInfo());
ipcMain.handle('link-connect', async (_evt, { code }) => link.connectPeer(code));
ipcMain.handle('link-disconnect', async () => { link.disconnectPeer(); return { ok: true }; });
ipcMain.handle('link-status', async () => ({
  host: link.hostInfo(),
  peerConnected: link.peerConnected(),
  sshConnected: link.sshConnected(),
  sshTarget: link.sshTarget(),
}));
ipcMain.handle('link-peer-projects', async () => link.peerListProjects());
ipcMain.handle('link-peer-recent', async (_evt, { days } = {}) => link.peerGetRecent(days || 30));
ipcMain.handle('link-peer-raw', async (_evt, { days } = {}) => link.peerGetRaw(days || 7));

// SSH transport: read a peer's logs over ssh (no Router needed on that machine)
ipcMain.handle('link-ssh-connect', async (_evt, { target } = {}) => link.sshConnect(target));
ipcMain.handle('link-ssh-disconnect', async () => { link.sshDisconnect(); return { ok: true }; });
ipcMain.handle('link-ssh-recent', async (_evt, { days } = {}) => link.sshGetRecent(days || 30));
ipcMain.handle('link-ssh-raw', async (_evt, { days } = {}) => link.sshGetRaw(days || 7));
ipcMain.handle('link-peers-list', async () => link.listPeers());
ipcMain.handle('link-peer-remove', async (_evt, { target } = {}) => link.removePeer(target));

ipcMain.handle('open-feed', async (_evt, server) => {
  await shell.openExternal((server || DEFAULT_SERVER).replace(/\/$/, ''));
});

// The in-app cohort feed: your posts + the room's, newest first (see
// router.cohortFeed). Read-only; the renderer marks your own.
ipcMain.handle('feed:get', async (_evt, opts = {}) => cohortFeed(opts || {}));

// Your current posting streak (consecutive days you posted to the Router).
ipcMain.handle('streak:get', async () => {
  try { return { streak: await postStreak() }; } catch { return { streak: 0 }; }
});

// ══════════════════════════════════════════════════════════════════════════
// Scope + redaction (Invariants I1–I5). main.js owns ONLY the IPC wiring; the
// decision engine lives in scope.js and the deterministic scrubber in
// redact.js. We never re-derive a privacy rule here — we call the modules.
// ══════════════════════════════════════════════════════════════════════════

const HOME = os.homedir();
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions');

// Local-only cache of the most recent scope:preview findings, keyed by
// finding.id, so redaction:reveal can return the original cleartext WITHOUT
// re-running the model or re-sending anything (I2 / reveal contract). This map
// is never serialized and never re-enters an outgoing string.
let lastPreviewFindings = new Map();

function p2(n) { return String(n).padStart(2, '0'); }

// Local-midnight bounds for a given date (mirrors transcripts.dayBounds intent;
// we only need this for cheap candidate discovery in scope:get).
function dayStartMs(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// (claudeDirToPath is imported from ./transcripts so scope decisions key on the SAME path.)

// Read only the cheap header lines of a Codex rollout file to learn its cwd +
// session id without loading message bodies.
function readCodexMeta(file) {
  return new Promise((resolve) => {
    let cwd = null;
    let sessionId = null;
    let stream;
    try { stream = fs.createReadStream(file, { encoding: 'utf8' }); }
    catch { return resolve({ cwd, sessionId }); }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const s = line.trim();
      if (!s) return;
      let obj;
      try { obj = JSON.parse(s); } catch { return; }
      if (obj && obj.type === 'session_meta') {
        const payload = obj.payload || {};
        cwd = payload.cwd || payload.cwd_path || cwd;
        sessionId = payload.id || payload.session_id || sessionId;
      }
    });
    rl.on('close', () => resolve({ cwd, sessionId }));
    stream.on('error', () => resolve({ cwd, sessionId }));
  });
}

// Enumerate candidate repo full paths active in [startMs, now] WITHOUT reading
// message bodies (I3: discover-then-gate). Returns per-fullPath the newest
// mtime (for the active-within-N-days include rule) and a session count.
async function discoverCandidates(startMs, date) {
  // fullPath -> { mtimeMs, sessions: Set }
  const byPath = new Map();
  const note = (fullPath, mtimeMs, sessionId) => {
    if (!fullPath) return;
    let e = byPath.get(fullPath);
    if (!e) { e = { mtimeMs: 0, sessions: new Set() }; byPath.set(fullPath, e); }
    if (typeof mtimeMs === 'number' && mtimeMs > e.mtimeMs) e.mtimeMs = mtimeMs;
    if (sessionId) e.sessions.add(sessionId);
  };

  // Claude: each project dir encodes a cwd; each .jsonl is a session.
  try {
    const dirs = fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
    for (const dir of dirs) {
      const fullPath = claudeDirToPath(dir);
      let entries = [];
      try {
        entries = fs.readdirSync(path.join(CLAUDE_PROJECTS, dir))
          .filter((f) => f.endsWith('.jsonl'));
      } catch { continue; }
      for (const f of entries) {
        const file = path.join(CLAUDE_PROJECTS, dir, f);
        let mtimeMs;
        try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
        if (mtimeMs < startMs) continue;
        note(fullPath, mtimeMs, f.replace(/\.jsonl$/, ''));
      }
    }
  } catch { /* no claude dir */ }

  // Codex: today's rollout files; cwd lives in the session_meta header.
  try {
    const d = new Date(date);
    const dayDir = path.join(CODEX_SESSIONS, String(d.getFullYear()),
      p2(d.getMonth() + 1), p2(d.getDate()));
    const files = fs.readdirSync(dayDir)
      .filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'))
      .map((f) => path.join(dayDir, f));
    for (const file of files) {
      let mtimeMs;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
      const meta = await readCodexMeta(file);
      const fullPath = meta.cwd || null;
      const sid = meta.sessionId || path.basename(file).replace(/\.jsonl$/, '');
      if (fullPath) note(fullPath, mtimeMs, sid);
    }
  } catch { /* no codex day dir */ }

  return byPath;
}

// A stable, human caption for a rule (UI shows these as "rules[].label/value").
function ruleView(rule) {
  if (!rule || typeof rule !== 'object') return null;
  switch (rule.kind) {
    case 'excludePathPrefix':
      return { id: rule.id, kind: rule.kind, label: 'Never read under', value: rule.path };
    case 'includePathPrefix':
      return { id: rule.id, kind: rule.kind, label: 'Always read under', value: rule.path };
    case 'activeWithinDays':
      return { id: rule.id, kind: rule.kind, label: 'Active within', value: `${rule.days} days` };
    case 'excludePrivateRepos':
      return { id: rule.id, kind: rule.kind, label: 'Never read', value: 'private repos' };
    default:
      return { id: rule.id, kind: rule.kind || 'rule', label: rule.kind || 'rule', value: '' };
  }
}

// Build the scope:get payload: discover candidates, ask scope.buildAllowSet for
// the deny-by-default decision over FULL paths (I3), then join with today's
// conversation counts. label is basename; fullPath disambiguates collisions.
async function buildScopeView(date = new Date()) {
  const scope = scopeMod.loadScope();
  const startMs = dayStartMs(date);
  const byPath = await discoverCandidates(startMs, date);

  const overrides = (scope.overrides && typeof scope.overrides === 'object') ? scope.overrides : {};
  const overridePaths = Object.keys(overrides).filter((fp) => typeof fp === 'string' && fp);
  const candidatePaths = [...new Set([...byPath.keys(), ...overridePaths])];
  const activity = {};
  for (const [fp, e] of byPath) activity[fp] = e.mtimeMs;

  const built = scopeMod.buildAllowSet(candidatePaths, scope, activity);
  const newSet = new Set(built.newRepos);

  const included = [];
  const excluded = [];
  const newRepos = [];
  for (const fp of candidatePaths) {
    const d = built.decisions[fp] || { included: false, reason: 'default-deny', ruleId: null, isNew: true };
    const label = path.basename(fp) || fp;
    const e = byPath.get(fp);
    const pinned = Object.prototype.hasOwnProperty.call(overrides, fp);
    if (newSet.has(fp)) {
      newRepos.push({
        fullPath: fp,
        label,
        convCount: e ? e.sessions.size : 0,
        lastActive: e ? e.mtimeMs : 0,
        reason: d.reason,
        ruleId: d.ruleId || null,
        pinned,
      });
    }
    if (d.included) {
      included.push({
        fullPath: fp,
        label,
        convCount: e ? e.sessions.size : 0,
        lastActive: e ? e.mtimeMs : 0,
        reason: d.reason,
        ruleId: d.ruleId || null,
        pinned,
      });
    } else {
      excluded.push({
        fullPath: fp,
        label,
        convCount: e ? e.sessions.size : 0,
        lastActive: e ? e.mtimeMs : 0,
        reason: d.reason,
        ruleId: d.ruleId || null,
        pinned,
      });
    }
  }

  const rules = (Array.isArray(scope.rules) ? scope.rules : []).map(ruleView).filter(Boolean);

  // A calm one-line summary the strip renders verbatim (counts only — never a
  // completeness claim about redaction).
  const inc = included.length;
  const exc = excluded.length;
  let summary;
  if (inc === 0 && exc === 0) {
    summary = 'No project activity to read today.';
  } else {
    const incPart = inc === 1 ? '1 folder allowed' : `${inc} folders allowed`;
    const excPart = exc === 0 ? 'nothing excluded' : (exc === 1 ? '1 repo excluded' : `${exc} repos excluded`);
    summary = `${incPart}; ${excPart}.`;
    if (newRepos.length) summary += ` ${newRepos.length} new repo${newRepos.length === 1 ? '' : 's'} out by default.`;
  }

  return {
    summary,
    rules,
    included,
    excluded,
    newRepos,
    collisions: built.collisions || [],
  };
}

// scope:get — the current allow/deny picture for today.
ipcMain.handle('scope:get', async () => buildScopeView());

// scope:pickFolder — ask macOS for one local folder and pin it into scope.
// This only grants Claude/Codex sessions rooted at that path; it does not crawl
// repo files directly.
ipcMain.handle('scope:pickFolder', async () => {
  const opts = {
    title: 'Add folder to Scope',
    buttonLabel: 'Add folder',
    defaultPath: HOME,
    properties: ['openDirectory'],
  };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (!result || result.canceled || !result.filePaths || !result.filePaths.length) {
    return { canceled: true };
  }

  let fullPath = result.filePaths[0];
  try { fullPath = fs.realpathSync(fullPath); }
  catch { fullPath = path.resolve(fullPath); }

  let stat;
  try { stat = fs.statSync(fullPath); }
  catch { throw new Error('That folder is not available.'); }
  if (!stat.isDirectory()) throw new Error('Choose a folder, not a file.');

  scopeMod.setOverride(fullPath, 'include');
  return { ...(await buildScopeView()), added: { fullPath, label: path.basename(fullPath) || fullPath } };
});

// scope:setRule — add/edit a rule ({ rule }) or remove one ({ remove }), then
// re-derive the scope view.
ipcMain.handle('scope:setRule', async (_evt, payload = {}) => {
  if (payload && payload.remove) {
    scopeMod.removeRule(payload.remove);
  } else if (payload && payload.rule) {
    scopeMod.setRule(payload.rule);
  }
  return buildScopeView();
});

// scope:override — pin a single full path include/exclude (or null to revert).
// Inclusion is NOT retroactive: it takes effect on the NEXT collect.
ipcMain.handle('scope:override', async (_evt, payload = {}) => {
  const { fullPath, decision } = payload;
  scopeMod.setOverride(fullPath, decision === undefined ? null : decision);
  return buildScopeView();
});

// scope:setConversation — exclude/include/clear a single session by id.
ipcMain.handle('scope:setConversation', async (_evt, payload = {}) => {
  const { sessionId, decision } = payload;
  scopeMod.setConversation(sessionId, decision === undefined ? null : decision);
  return { ok: true };
});

// scope:preview — the TWICE-scrubbed result for a day (defaults today):
// scrub #1 over the digest happens inside collectToday (its `redactions` are
// the digest-stage findings); scrub #2 runs in generate() over the model's
// post/headline. Chips/counts bind to postFindings (the FINAL outgoing string,
// I2). We cache the union of findings by id for local reveal.
ipcMain.handle('scope:preview', async (_evt, payload = {}) => {
  const date = (payload && payload.date) ? new Date(payload.date) : new Date();
  const scope = scopeMod.loadScope();

  // Live-draft recompute (additive within the frozen channel): when the renderer
  // passes the visible draft bytes (e.g. the leave-confirm honesty check), scrub
  // THOSE bytes through the SAME redact() that the post handler runs (I2 final
  // hop) and return postFindings over them — so the manifest counts and the
  // shown draft come from the same bytes, even after hand-edits. No model call.
  if (payload && typeof payload.draft === 'string') {
    const rules = scopeMod.loadRules();
    const scrub = redact(payload.draft, rules);
    const postFindings = Array.isArray(scrub.findings) ? scrub.findings : [];
    const cache = new Map();
    for (const f of postFindings) if (f && f.id) cache.set(f.id, f);
    lastPreviewFindings = cache;
    return { post: scrub.masked, headline: '', digestFindings: [], postFindings, readFiles: [], excludedCount: 0, held: [] };
  }

  const collected = await collectToday(date, scope);

  const digestFindings = Array.isArray(collected.redactions) ? collected.redactions : [];
  const held = Array.isArray(collected.held) ? collected.held : [];
  const excludedCount = typeof collected.excludedCount === 'number' ? collected.excludedCount : 0;

  // What we actually read, grouped by repo (basename label + full path), with
  // the same conversation counts the strip shows.
  const readFiles = (collected.stats && Array.isArray(collected.stats.projects))
    ? collected.stats.projects.map((p) => ({
        fullPath: p.fullPath,
        label: p.name,
        files: Array.isArray(p.sources) ? p.sources : [],
        convCount: typeof p.messages === 'number' ? p.messages : 0,
      }))
    : [];

  let post = '';
  let headline = '';
  let postFindings = [];
  if (collected.hasActivity && collected.digest && collected.digest.trim()) {
    // scrub #2 lives inside generate(): post/headline come back already masked
    // and postFindings are the findings over the FINAL outgoing strings (I2).
    const dateLabel = (collected.stats && collected.stats.date)
      ? collected.stats.date
      : date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const gen = await generate(collected.digest, { name: resolveName(), dateLabel });
    post = gen.post || '';
    headline = gen.headline || '';
    postFindings = Array.isArray(gen.postFindings) ? gen.postFindings : [];
  }

  // Cache originals locally for redaction:reveal — every finding from BOTH
  // stages, keyed by id. Never persisted, never re-sent.
  const cache = new Map();
  for (const f of digestFindings) if (f && f.id) cache.set(f.id, f);
  for (const f of postFindings) if (f && f.id) cache.set(f.id, f);
  lastPreviewFindings = cache;

  return { post, headline, digestFindings, postFindings, readFiles, excludedCount, held };
});

// redaction:rule — mutate always-hide terms / client abstractions, returns the
// new rules object (the SAME shape passed to redact(text, rules)).
ipcMain.handle('redaction:rule', async (_evt, payload = {}) => {
  const rules = scopeMod.loadRules();
  const hide = Array.isArray(rules.hide) ? rules.hide.slice() : [];
  const abstractions = Array.isArray(rules.abstractions) ? rules.abstractions.slice() : [];
  const { op, term, from, to, index } = payload || {};
  const isAbstraction = (from !== undefined && from !== null) || (to !== undefined && to !== null);

  if (op === 'add') {
    if (isAbstraction) {
      if (from) abstractions.push({ from: String(from), to: String(to == null ? 'a client' : to) });
    } else if (term) {
      hide.push(String(term));
    }
  } else if (op === 'edit') {
    if (isAbstraction && typeof index === 'number' && index >= 0 && index < abstractions.length) {
      const cur = abstractions[index] || {};
      abstractions[index] = {
        from: from != null ? String(from) : cur.from,
        to: to != null ? String(to) : cur.to,
      };
    } else if (term && typeof index === 'number' && index >= 0 && index < hide.length) {
      hide[index] = String(term);
    }
  } else if (op === 'remove') {
    if (typeof index === 'number' && index >= 0) {
      // Target abstractions when from/to is present; otherwise the hide list.
      if (isAbstraction) {
        if (index < abstractions.length) abstractions.splice(index, 1);
      } else if (index < hide.length) {
        hide.splice(index, 1);
      }
    }
  }

  const next = { version: rules.version || 1, hide, abstractions };
  scopeMod.saveRules(next);
  return { hide: next.hide, abstractions: next.abstractions };
});

// redaction:reveal — LOCAL ONLY. Return the original cleartext for an on-screen
// reveal, looked up in the last preview's in-memory findings map. NEVER calls
// the model, NEVER persists, NEVER re-enters any outgoing string.
ipcMain.handle('redaction:reveal', async (_evt, payload = {}) => {
  const id = payload && payload.findingId;
  const f = id ? lastPreviewFindings.get(id) : null;
  return { original: f && typeof f.original === 'string' ? f.original : '' };
});

app.whenReady().then(() => {
  ensureDockIcon();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
