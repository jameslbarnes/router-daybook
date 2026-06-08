# AGENTS.md — working notes for agents on Teleport Router (repo: `router-daybook`)

Guidance for AI agents (and humans) working in this repo. Read this before making
changes; it records *why* things are the way they are so you don't undo deliberate
decisions. See `README.md` for the user-facing tour.

It is **not** a standalone product — it's the **desktop interface to the Router**, and
ultimately the front end for [`router-teamwork`](https://github.com/teleport-computer/router-teamwork).
"Daybook" is just the repo codename; the product is **Teleport Router**.

## What this is

**Teleport Router** (Electron desktop app; package name `router`, repo `router-daybook`)
reads your local **Claude Code** (`~/.claude/projects/*/*.jsonl`) and **Codex**
(`~/.codex/sessions/...`) sessions, writes a first-person daily reflection via the local
`claude -p` CLI, and — only when you approve — posts it to the **Router**, a cohort's
shared read-only feed (`https://router.teleport.computer`, override `ROUTER_SERVER`).

Founding values, in priority order: **simple, calm, privacy-conscious** — and a fourth
that emerged: **restraint** (the generator says nothing fake; see the eval). When in
doubt, choose the simpler, quieter, more honest option.

## How it works (the pipeline)

`collect` → `generate` → `review/refine` → `post`:

1. **transcripts.js** discovers sessions **since your last Router post** (`collectSinceLastPost`,
   anchored to `router.lastOwnPostMs` — the server timestamp — with a 7-day floor), scope-gates
   them deny-by-default *before reading bodies*, and compacts them into a digest. Secrets are
   masked here, before the digest can become a prompt.
2. **reflect.js** spawns `claude -p` (the user's subscription) to write the post **plus a bundled
   `firstQuestion`** (the refine opener). Its prompt is built FROM `postspec.js` so the generator
   and the eval share one contract. Scrubs the digest before the spawn and the post after.
3. **renderer** shows the draft AS a directly-editable `<textarea>` (no markdown render, no
   read-only view). Under it: the bundled question + a **"Refine in interview"** CTA that opens
   the interview seeded on that question. Footer: **Start over · Skip · Post**.
4. **router.post** re-scrubs the exact outgoing bytes and posts to `/api/entries` (staged,
   deletable). The header **posting streak** (`router.postStreak`) refreshes.

## Run it / test it

```bash
npm install
npm start                # electron .
npm run collect          # node src/transcripts.js — prints today's digest, standalone
npm run eval:fixtures    # the locked rubric's meta-eval (gates + claude -p judge)
node evals/run.js <post.json>   # score one post;  add --gates to skip the model
```

- **Re-run onboarding:** `mv ~/.router-daybook/introduced{,.bak}`; relaunch; move it back after.
- **See the Connect screen:** `mv ~/.routerrc{,.bak}`; relaunch; move it back.
- No automated UI tests. `node --check <file>` catches **syntax only** — not runtime
  `ReferenceError`s. After renderer edits, cross-check that every `$('id')` in `app.js` exists in
  `index.html` (a missing element silently breaks init). Verify by launching.

### ⚠️ Electron does not hot-reload
Editing `renderer/` or `src/` does nothing to a running window. Restart:
```bash
pkill -f "router-daybook/node_modules/electron"; npm start
```

## Architecture / file map

| File | Role |
|------|------|
| `src/main.js` | Electron main; all `ipcMain` handlers; threads scope into collect/generate; `resolveName()` → user's FIRST name. |
| `src/preload.js` | `contextBridge` — the only renderer↔main surface (`window.daybook.*`). Every channel needs a matching `ipcMain.handle`. |
| `src/profile.js` | Local app profile (`~/.router-daybook/profile.json`), currently the Settings name. |
| `src/transcripts.js` | Discover + compact sessions → digest. `collectSinceLastPost` (window), `collectToday`, `collectRecent`. Scope-filters before reading; masks secrets. Standalone-runnable. |
| `src/reflect.js` | `generate()` → post + `firstQuestion`. Two scrub hops (digest in, post out). Prompt built from `postspec`. |
| `src/postspec.js` | **LOCKED** post contract: `BANNED`, lead-in order, `LENGTH`, `THRESHOLD`, `RUBRIC_VERSION`. Shared by `reflect.js` and `evals/gates.js`. |
| `src/intro.js` | Interview engine (`firstQuestion`/`nextQuestion` with optional `purpose`/`goals`/`focus` overrides — reused by the **refine** flow), intro writing, MLX-Whisper transcription. |
| `src/scope.js` | Per-repo scope (`scope.json`), keyed on FULL path, deny-by-default. |
| `src/redact.js` | Deterministic secret scrubber. Pure, no I/O, never throws. |
| `src/router.js` | All Router HTTP: `post`, `fetchFeed`, `cohortFeed`, `lastOwnPostMs`, `postStreak`, `whoami`, `joinWithInvite`, `useExistingKey`, `saveConfig`. |
| `src/link.js` | Device-link (pairing code + SSH) to pull a peer's work. Scope-gated + scrubbed. |
| `evals/` | The locked eval: `gates.js` (G1–G5), `judge.js` (D1–D6 via `claude -p`), `score.js`, `run.js`, `rubric.md`, `fixtures/`, `draft.workflow.js`. |
| `renderer/` | Vanilla-JS single window. The directly-editable editor; the canvas **disco ball** (`startDiscoBall`). |

IPC convention: legacy/link channels are kebab (`link-host-start`); newer features are namespaced
(`scope:get`, `feed:get`, `streak:get`, `refine:start/next/write`, `use-key`).

## The locked eval (don't quietly weaken the rubric)

`src/postspec.js` + `evals/rubric.md` are the contract; `reflect.js` builds its prompt from it.
Changing the criteria is a deliberate `RUBRIC_VERSION` bump, validated by the meta-eval
(`npm run eval:fixtures` — `good` passes, `lame`/`spurious`/`forced`/`trivial-ask`/`manufactured-ask`
/`plumbing` fail on the right dimensions; `restraint`/`usage-ask` reward honest omission and
high-value asks). The rubric (v4) encodes **restraint + importance**: a forced/plausible @-mention
scores worse than none; a manufactured or trivial ask scores low; honest omission is full marks.
Keep prompt and rubric in lock-step.

## The privacy model (don't quietly weaken this)

Two things leave the machine, and the UI stays honest about both: (1) the **digest → Anthropic**
via `claude -p` (cloud inference on the user's subscription — always happens to write the post);
(2) the **approved post → the Router cohort**, only on Post. Never claim "nothing leaves."

- **Secret scrubbing (`redact.js`)** is deterministic CODE, not a prompt instruction. It runs on
  the digest before the spawn, the generated post after, and the device-link raw path. Best-effort
  — never claim it caught everything.
- **Scope (`scope.js`)** is keyed on FULL repo path, deny-by-default; sources are filtered before
  reading.
- The user's **key** lives in `~/.routerrc` (home), never the repo. `.gitignore` also covers
  `.routerrc`/`.env`/`*.key`/`*.pem`/`.router-daybook/` defensively.

## What we changed recently (keep it this way unless asked)

- **The draft IS the editor.** The old read-only markdown article + footnote/redaction tooltips +
  the "say what to change" revise box + the learned-patterns chip were removed. Revision happens by
  typing directly, by **Start over** (regenerate), or by the **Refine in interview** flow. Backend
  for the old revise/learning (`learning.*`, `revise` IPC) still exists but is unused by the UI.
- **Posts/intro are PLAIN TEXT** (no markdown) so they read clean in the editor. Lead-ins:
  `Wins / [Struggles] / Insight / [Offering] / [Asking]` — only Wins + Insight required.
- **The user's first name can be set in Settings.** It is saved locally in
  `~/.router-daybook/profile.json`; `resolveName()` prefers `DAYBOOK_NAME`, then Settings, then
  `~/.routerrc` `name`, and falls back to a neutral subject instead of guessing.
- **The look is an experiment** — light + glitch + brutalist (rotating glitch disco ball, electric
  blue accent, square hard borders). It is NOT the calm dark theme; treat it as in-flux.

## The plan

- **Daily automation (daemon):** a background, debounced pre-generation so the draft is *already
  there* when the app opens. There's no local model to keep warm (cloud call) — the move is to fire
  the request early, not keep a process hot.
- **Agent-answerable asks:** tag each ask `seeks: human|agent|both` so a reader's agent can answer
  factual asks from their logs and surface only judgment calls.
- **Wire the eval into runtime:** deterministic gates as a guard in generate/post; optional best-of-N.
- **Packaging:** a signed `.dmg` (still needs the `claude` CLI + a key).

## Conventions

- **Voice:** plain, honest, calm, no hype, **no emoji** in user-facing prose.
- Vanilla JS in `renderer/` (no framework); CommonJS in `src/`. Match surrounding style.
- No new npm deps without reason; Node builtins + Electron only.
- Mono/serif/sans roles per the current theme; one `.btn.primary` per surface.

## Repo / housekeeping

- Git repo; private remote `origin` → `github.com/jameslbarnes/router-daybook`.
- **Gitignored on purpose:** `node_modules/`, `.backups/` (local pre-edit snapshots), **`interviews/`**
  (the user's personal interview transcripts — real reflections, not code; do **not** commit), and
  the defensive secret patterns above.
- End commit messages with the standard `Co-Authored-By:` trailer.
