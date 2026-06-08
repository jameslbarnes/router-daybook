# Teleport Router

> *This router is dedicated to the common understanding of all humanity.*

The calm, private **desktop interface to the Router** — and, ultimately, the front end
for [`router-teamwork`](https://github.com/teleport-computer/router-teamwork). It is **not a
separate product**; it's a front door to the same shared feed. (Repo / codename:
`router-daybook`.)

Every day you have long, detailed conversations with **Claude Code** and **Codex**: what
you tried, where you got stuck, what you decided, what shipped. That record is exactly
what your team would want to see — and it evaporates every night. Teleport Router reads
those sessions **locally**, writes you an honest **first-person daily reflection**, and —
only when you approve — posts it to the **Router**: your team's shared feed.

The Router itself stays read-only. The writing happens here, on your machine, with you
as the gate.

---

## The bet

Two ideas this is built around:

1. **The exhaust is the signal.** The best record of what you did today already exists,
   in your AI sessions. Teleport Router stops throwing it away.
2. **Collaboration is a search problem, not a social one.** The value isn't posting — it's
   *matching*: the one person whose problem you just solved, or who solved yours. Much of
   that matching can be done by a reader's *agent* (grounded in their real logs), leaving
   *people* for the judgment calls. The feed becomes a place where **work finds work.**

And one design ethic that runs through the whole thing: **restraint.** The generator is
built to *shut up unless it has something real to say* — no forced @-mentions, no
manufactured asks, no engagement bait (see [The locked eval](#the-locked-eval-what-good-means)).

---

## The daily loop

```
~/.claude/projects/*/*.jsonl ─┐
                              ├─► transcripts.js ──► reflect.js (claude -p) ──► you review/edit ──► router.js
~/.codex/sessions/Y/M/D/*.jsonl ┘   (since your         (writes the post +         (the editor IS        POST /api/entries
                                     last post)          a refine question)         the draft)            (staged, deletable)
```

1. **Collect** — `transcripts.js` discovers your Claude + Codex sessions **since your last
   Router post** (anchored to the post's server timestamp, so it's correct on any machine;
   7-day fallback if you've never posted), scope-filters them deny-by-default, and compacts
   them into a digest. Secrets are scrubbed *before* anything becomes a prompt.
2. **Generate** — `reflect.js` spawns the local `claude -p` (your Claude subscription) to
   write a plain, third-person daily update *and* a single sharpening question.
3. **Review** — the draft **is** a directly-editable text box. Type in it, hit **Start over**
   for a fresh take, or click **Refine in interview →** under the draft to sharpen it in a
   short conversation (voice or text).
4. **Post** — your approved post is re-scrubbed one last time and sent to the Router. It lands
   in a **staging** buffer (deletable for a window before it goes public). Your **posting
   streak** in the header ticks up.

### The post format

Plain text (no markdown), led by `Router digest · <window>` and a one-line summary, then:

- **Wins —** what shipped or moved forward.
- **Struggles —** *(only if real friction)* genuine blockers, not routine decisions.
- **Insight —** the one thing you concluded.
- **Offering —** *(omit by default)* concrete help for a **named** peer whose stated problem
  your work actually solves.
- **Asking —** *(optional)* a genuine, high-value ask — help testing what you shipped,
  feedback on how people would use it, a real direction call — never a solved problem dressed
  up as a blocker, never trivia.

Cited @-mentions carry a verbatim quote + a superscript footnote, with a `Sources` footer, so
the published post is self-contained and verifiable in the feed.

---

## First run — onboarding

No blank "introduce yourself" form. On first run you'll hit:

1. **Connect** *(if you have no key yet)* — paste an **invite link/code** + pick a handle to
   join, **or** click *"Already have a key? Paste it"* to use an existing Router key (validated
   against the server before it's saved, so a bad key never clobbers a good `~/.routerrc`).
2. **Welcome** — *"You're initiating the Teleport Router v0.1."* — a grounded welcome note
   generated from your most recent day of real work.
3. **Interview** — a short, dynamic, one-question-at-a-time conversation (type or **speak** —
   audio transcribes **on-device** via MLX Whisper, never leaving the machine) that draws out
   who you are, what you can give, and what you want.
4. **Intro** — a third-person self-introduction written from your answers, on the same editable
   draft screen → Post. After that, the `~/.router-daybook/introduced` flag is set and launches
   go straight to the daily digest.

The intro and posts use your name from **Settings** (saved locally in
`~/.router-daybook/profile.json`). If you leave it blank, Router uses a neutral subject
instead of guessing.

---

## The locked eval — what "good" means

The distinctive piece. Rather than tuning the generator by feel, "what a good post is" is
**defined and locked** in `src/postspec.js` (machine-readable) + `evals/rubric.md` (prose), and
the generator's prompt is built *from* that contract so the two can't drift.

`evals/` scores any post against the rubric:

- **Deterministic gates (G1–G5)** — structure/order, citation integrity (markers ↔ footnotes ↔
  Sources, quotes verbatim from the feed), a **banned-phrasings** list (the hedge register:
  *"compare notes", "open to collaboration", "would be glad to"…*), safety (reuses the secret
  scrubber), length.
- **An LLM judge (D1–D6, `claude -p`)** — offering quality, asking quality, match-substance,
  plainness/anti-lameness, signal-vs-noise, faithfulness.

The rubric (v4) encodes **restraint and importance**: a *forced or merely-plausible* @-mention
scores **worse** than none; an ask manufactured from a solved problem, or trivial implementation
minutiae, scores low; honest omission scores full marks. A self-validating **meta-eval** over
`evals/fixtures/` proves the rubric rejects lame/spurious/manufactured posts and passes genuine
ones. `evals/draft.workflow.js` is a best-of-N drafting workflow that optimizes that locked score.

---

## Privacy — where your data goes (honestly)

- **On-device:** reading your session files; **voice transcription** (MLX Whisper runs locally —
  audio never leaves); the **deterministic secret scrubber** (`src/redact.js`).
- **To Anthropic's cloud:** text generation, via `claude -p` on **your own Claude subscription**
  (same inference path as normal Claude Code — no API key, no extra third party). The digest is
  scrubbed *before* it enters the prompt.
- **To the Router:** feed reads, identity, and the **post you approve** (scrubbed again on the way
  out).
- **The guarantee that matters:** nothing is *posted to the cohort* until you approve it, and
  posts land in a deletable staging buffer first. We never claim "nothing leaves your machine" —
  generation is cloud inference on your subscription. Secret-scrubbing is **deterministic code**
  (not a model we hope behaves), and **scope** is deny-by-default, keyed on full repo path.

Your key lives in `~/.routerrc` (home), never in the repo.

---

## Run it

```bash
npm install
npm start
```

**Requirements:**

- macOS, Node.js.
- The **`claude` CLI** on your PATH, logged in (this is what writes the posts — your Claude
  subscription).
- A Router identity: either an **invite link/code** (join in-app) or an existing **key** (paste
  in-app). Stored in `~/.routerrc` as `{ "key": "<your router key>" }`.
- *Optional, for voice answers:* `ffmpeg` + `uv`/`uvx` (MLX Whisper). Degrades gracefully if absent.

Posts to `https://router.teleport.computer` by default; override with `ROUTER_SERVER=…`.

> ⚠️ **Electron does not hot-reload.** After editing `renderer/` or `src/`, restart:
> `pkill -f "router-daybook/node_modules/electron"; npm start`

## Test it

- **The digest, standalone (no UI, no posting):** `npm run collect` (`node src/transcripts.js`) —
  prints today's stats + digest.
- **The eval / meta-eval:** `npm run eval:fixtures` — runs the locked rubric over the fixtures and
  asserts each lands where expected (good passes, lame/spurious/manufactured fail on the right
  dimensions). `node evals/run.js <post.json>` scores one post; `--gates` skips the model.
- **Re-run onboarding:** `mv ~/.router-daybook/introduced ~/.router-daybook/introduced.bak`, relaunch
  → you'll land on Welcome/onboarding; move it back to return to the daily flow.
- **See the Connect screen:** `mv ~/.routerrc ~/.routerrc.bak`, relaunch (then move it back).
- There are **no automated UI tests** — `node --check <file>` catches syntax only. Verify by
  launching, and cross-check that every `$('id')` in `renderer/app.js` exists in `index.html`.

---

## Architecture / file map

| File | Role |
|------|------|
| `src/main.js` | Electron main process; registers all `ipcMain` handlers; threads scope into collect/generate; resolves the user's **first name**. |
| `src/preload.js` | `contextBridge` — the only renderer↔main surface (`window.daybook.*`). |
| `src/profile.js` | Local app profile (`~/.router-daybook/profile.json`), currently the Settings name. |
| `src/transcripts.js` | Discovers + compacts sessions into a digest; **since-last-post** window; scope-filters before reading; masks secrets. Standalone-runnable. |
| `src/reflect.js` | Spawns `claude -p` to write the post + a bundled refine question. Scrubs the digest before, and the post after. Builds its prompt from `postspec`. |
| `src/postspec.js` | The **locked** post contract (banned phrasings, lead-in order, length, score threshold). Shared by the generator and the eval. |
| `src/intro.js` | First-run interview engine (also reused by the in-app **refine** flow) + intro writing + on-device transcription helpers. |
| `src/scope.js` | Per-repo scope store (`scope.json`), keyed on full path, deny-by-default. |
| `src/redact.js` | The deterministic secret scrubber. Pure, no I/O, never throws. |
| `src/router.js` | All Router HTTP: post, feed, cohort feed, identity, join-by-invite, **paste-existing-key**, **posting streak**. |
| `src/link.js` | Device-link (pairing-code TCP + SSH) to pull a peer's work, scope-gated + scrubbed. |
| `evals/` | The locked eval: `gates.js`, `judge.js`, `score.js`, `run.js`, `rubric.md`, `fixtures/`, `draft.workflow.js`. |
| `renderer/` | Single-window vanilla-JS UI (`index.html`, `app.js`, `styles.css`); the directly-editable draft editor + the rotating disco ball. |

Persisted state lives in `~/.router-daybook/` (not the repo): `profile.json`, `scope.json`,
`redactions.json`, `notes.jsonl`, `patterns.json`, `checkpoint.json`, `peers.json`, `introduced`. Your interview
transcripts are saved to `interviews/` (gitignored — personal).

---

## The plan

- **Daily automation (the daemon).** Right now the digest generates when you open the app. Next:
  a background agent that wakes on new activity (debounced to ~once per work burst) and
  pre-generates the draft + question, so by the time you open it, it's **already there**. The win
  is starting the inference *before* you're waiting on it — there's no local model to keep warm
  (it's a cloud call), so the move is "fire it early," not "keep a process hot."
- **Agent-answerable asks.** Tag each ask with what it *seeks* (human judgment vs grounded
  retrieval), so a reader's agent can answer factual asks straight from their own logs and surface
  only the judgment calls to the human.
- **Wire the eval into the app.** Run the cheap deterministic gates inside the generate/post flow
  so a malformed or lame post never reaches you; optionally best-of-N with the judge.
- **Packaging.** A signed `.dmg` so teammates can double-click (it still needs the `claude` CLI +
  a key — that dependency doesn't go away).
- **Smaller:** weave in the Router daily question; "roll a thin day into tomorrow"; a calmer
  fallback look toggle.

## Status — v0.1 (experimental)

The core loop is real: since-last-post collection, restraint-tuned generation, a directly-editable
review surface, the refine interview, the in-app feed, a locked + self-validating eval, posting
streaks, and two onboarding paths (invite / paste-key).

The **look is deliberately rough** — a light, glitchy, brutalist experiment (rotating glitch disco
ball, electric-blue accents, hard edges). React to the vibe; don't trust the polish.
