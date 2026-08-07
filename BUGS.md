# doet — bug report

Audit of `doet` (v0.1.0, ~2.9k LOC of `src/`) performed 2026-08-07. **Nothing was fixed**; this
file only records what was found.

Baseline facts, so the list below is read in context:

- `npx tsc --noEmit` passes clean. Every bug here is a **runtime/logic** bug, not a type error.
  The type checker is not going to catch any of these for you.
- `tsconfig.json` `include` is `["src"]`, so the six files in `scripts/` are never typechecked
  by `npm run typecheck` despite three of them being `.ts`/`.tsx`.
- There is no test suite and no `test` script.
- The findings marked **[verified]** were reproduced by executing code (throwaway probe scripts
  run under `tsx`, since removed). Findings marked **[traced]** were established by reading the
  code path and, where relevant, the installed `@anthropic-ai/claude-agent-sdk@0.3.224` type
  declarations — no execution, because they need a live `claude`/`codex` login.

Severity key: **S1** breaks or hangs the product · **S2** wrong behaviour a user will hit ·
**S3** correctness/robustness nit · **S4** cosmetic or hygiene.

---

## S1 — Hangs and deadlocks

### 1. A missing `codex` binary hangs doet forever at startup, with no output [verified]

`src/core/adapters/jsonrpc.ts:70-80`, `:134-141` · `src/cli.tsx:188-203`

`JsonRpcClient` rejects its in-flight requests only from `child.on('exit')`:

```ts
child.on('exit', (code) => {
  for (const [, deferred] of this.inflight) deferred.reject(new Error(`codex app-server exited …`));
```

When `spawn()` fails with `ENOENT`, Node emits **`error` and `close`, but never `exit`**. Verified
directly:

```
$ node -e "spawn('definitely-not-a-real-binary-xyz',…)"
EVENTS: error:ENOENT | close:-2
```

So `CodexAdapter.start()`'s `await this.rpc.request('initialize', …)` (`codex.ts:130`) never
settles. Reproduced against the real class:

```
onError: spawn doet-no-such-binary-xyz ENOENT
RESULT: request() NEVER settled after 2s -> start() hangs forever
```

`cli.tsx:188` does `await Promise.all(AGENT_IDS.map(… start()))`, so the process hangs before
`render()`. The carefully written failure path at `cli.tsx:198-203` —

> `doet could not start both agents:` … `Check that \`claude\` and \`codex\` are on PATH and logged in.`

— is **unreachable for the single most likely misconfiguration**, which is exactly the one
`README.md:129` warns about. The user sees a silent hung terminal.

Two independent contributors: (a) `close` is not handled, (b) `request()` has no timeout, and
`JsonRpcClient.stop()` (`:152-157`) also does not reject `inflight`.

### 2. The summary agent can deadlock the entire debate on a permission prompt nobody can see [traced]

`src/core/summarizer.ts:113-134`, `:50-54`, `:163-187` · `src/core/adapters/claude.ts:145`,
`:264-315` · `src/core/conductor.ts:238, 261-274`

`ClaudeAdapterOptions.readOnly` is documented (`claude.ts:35-40`) as:

> Strips every tool. Used for the summary agent, which … **must never raise a permission prompt**,
> since it runs off to the side of the debate where nobody is watching for one.

It is implemented as `...(this.opts.readOnly ? { allowedTools: [] } : {})`. But the installed SDK
defines `allowedTools` as (`sdk.d.ts:1368-1375`):

> List of tool names that are **auto-allowed without prompting** for permission. … **To restrict
> which tools are available, use the `tools` option instead.**

`allowedTools: []` is therefore a **no-op**: the summarizer keeps every tool (Bash, Write, …), and
because no `permissionMode` is passed it defaults to `'default'`, so `canUseTool` fires. The chain
that follows:

1. `ClaudeAdapter.onPermission` emits `{kind:'permission'}` on the summarizer's **`innerBus`** and
   `await`s a `Deferred` (`claude.ts:308-309`) with no timeout.
2. The only `innerBus` subscriber (`summarizer.ts:50-54`) forwards **`error` events only**.
3. `resolvePermission` is called from exactly one place — `App.tsx:662` — which is driven by the
   **outer** bus. `grep -rn resolvePermission src/` confirms there is no other caller.
4. Nothing can ever settle that `Deferred`. `Summarizer.update()` (`:167`) awaits it forever.
5. `Conductor.updateGist` (`:264`) awaits `summarizer.update`. Its `try/catch` at `:271-273`
   catches rejections but **cannot catch a promise that never settles**.
6. `Conductor.run` awaits `updateGist` at `:238`, between every pair of turns.

Net effect: one tool call by the note-taker freezes the debate permanently, with no prompt on
screen and no error. The Codex summariser path is safe (`approvalPolicy: 'never'`,
`sandbox: 'read-only'`, `summarizer.ts:125-126`) — but the default config is
`summary: { agent: 'claude', model: { id: 'haiku' } }` (`config.ts:50`), i.e. the unsafe path is
the default.

### 3. Rotating or disposing a Claude session mid-turn bricks the adapter permanently [traced]

`src/core/adapters/claude.ts:179-196`, `:215-243`, `:464-465`, `:472-473`

`this.turn` (the `Deferred` returned by `send()`) is nulled in exactly two places — `finishTurn`
and `fail`. `closeSession()`, which `newSession()` and `dispose()` both call, never touches it:

```ts
private async closeSession(): Promise<void> {
  this.closed = true;
  this.inboxWaiter?.resolve();
  …                                   // pending permissions resolved; this.turn is not
  await this.session?.return(…);
  await this.pump?.catch(() => {});
```

If the SDK stream ends cleanly without a `result` message, `consume()` returns normally, so `fail()`
never runs. Two consequences:

- The caller's `send()` promise never resolves. `Conductor.speak()` awaits it forever.
- `this.turn` stays non-null, so **every subsequent `send()` throws
  `'Claude is already mid-turn.'`** (`claude.ts:217`) for the rest of the process lifetime.

Reachable from the UI with no guard: `App.tsx:535-542` (`/session claude new`) and `:622-641`
(`/new`) both call `conductor.rotate()` without checking `conductor.isRunning`.

The same `closeSession()` also makes **ctrl+c** unreliable: `shutdown()` (`App.tsx:653-659`) awaits
`Promise.all(dispose())` **before** calling `exit()`, and `dispose()` awaits `this.pump`.

---

## S2 — Wrong behaviour a user will hit

### 4. A debate can "converge" after two turns because the opening agent's AGREE counts [verified]

`src/core/conductor.ts:222-228` · `src/core/relay.ts:21-29`

```ts
// Convergence needs agreement from *both* sides in a row. One agent
// saying AGREE only means it liked what it just read.
agreeStreak = result.verdict === 'AGREE' ? agreeStreak + 1 : 0;
```

The comment is the intent; `README.md:165` states it as a feature ("It takes both sides in a row").
But round 0 is the **opening** turn, where there is nothing to agree with — `openingPrompt` still
appends `VERDICT_INSTRUCTIONS`, whose text ("the other agent's version is correct and complete")
is meaningless at that point. A model that emits AGREE there seeds the streak.

Reproduced with fake adapters:

```
CASE A -> {"reason":"converged","rounds":2,"finalFrom":"codex"}
  codex saw 1 prompt(s); claude saw 1
```

`doet`'s stated purpose is "passes a question between Claude Code and Codex **until they agree**".
Here Codex reads the question once, says AGREE, and the session is declared converged — no
critique, no revision, no second opinion. The user gets a single-agent answer wearing a two-agent
badge. Round 0's verdict should not be counted (or the opening prompt should not solicit one).

### 5. `/stop` and `ctrl+x` do not stop — doet sends one more turn [verified]

`src/core/conductor.ts:217-220`, `:388-435` · `README.md:74-75`

`run()` breaks with `reason = 'stopped'`, then `conclude()` falls through to the synthesis branch
(`:419-435`) because only `reason === 'error'` short-circuits. Reproduced — the user calls
`requestStop()` during turn 1:

```
after /stop on turn 1 -> {"reason":"stopped","rounds":1}
  claude turns sent: 2 labels: ["opening","final version"]
  => doet sent 1 EXTRA turn(s) after the user asked it to stop
```

Worse for `ctrl+x` (`App.tsx:744-747` → `conductor.abort()` → `adapter.interrupt()`): the agent is
interrupted mid-sentence and then **immediately handed a fresh prompt**, which is the opposite of
"abort the current turn now" (`README.md:75`). `stopRequested` is never consulted in `conclude()`.

### 6. `--rounds` with a bad value silently produces an empty, zero-turn "debate" [verified]

`src/cli.tsx:66-69`, `:181`

```ts
case '--rounds': args.rounds = Number(value); i++; break;
…
maxRounds: args.rounds ?? config.debate.maxRounds,
```

`Number('abc')` is `NaN`, and `NaN ?? x` is `NaN` — `??` only guards `null`/`undefined`. `--rounds`
with a missing value gives `Number(undefined) === NaN` too, and `--rounds 0` gives `0`. All three
make `for (…; this.round < this.config.maxRounds; …)` never execute:

```
CASE B -> {"query":"do the thing","rounds":0,"reason":"exhausted","final":"","finalFrom":"claude"}
```

The UI then reports `Saved to …/session.md` (`App.tsx:435`) and `SessionStore.finalize` writes a
`## Final version` heading with an empty body. No error anywhere. Note the in-session `/rounds`
command **does** validate (`App.tsx:594-598`, `!Number.isFinite(n) || n < 1`) — the CLI flag was
just never given the same check.

### 7. The `tokens:N` session policy is measured against the wrong number for Claude [traced]

`src/core/adapters/claude.ts:443-448` · `src/core/conductor.ts:322-327`

`finishTurn` **overwrites** `this.usage` every turn rather than accumulating, and populates it from
`message.usage`. The SDK documents that field as (`sdk.d.ts:4470-4473`):

> MAIN AGENT LOOP ONLY … and is **per-turn in streaming-input sessions**. Prefer `modelUsage` for
> token/cost accounting.

`doet` runs streaming-input mode. So `info().usage.inputTokens/outputTokens` is the **last turn's**
count, and `rotationDue()` compares that single turn against `policy.limit`:

```ts
const used = info.usage.totalTokens ?? (info.usage.inputTokens ?? 0) + (info.usage.outputTokens ?? 0);
return used >= policy.limit ? … : null;
```

`/session claude policy tokens:150000` will therefore essentially never fire. Meanwhile the Codex
adapter reads `tokenUsage.total`, a genuine running thread total (`codex.ts:525-541`) — so the same
user-facing policy means two different things depending on which agent it is set on. Three knock-on
effects:

- `totalTokens` is never set by the Claude adapter, so the fallback branch is always the one taken.
- The pane's token badge (`AgentPane.tsx:108-110`) shows last-turn tokens next to what a user will
  read as a session total.
- `costUsd` comes from `total_cost_usd`, which the SDK documents as **cumulative** — so a single
  `Usage` object mixes a cumulative cost with per-turn token counts.

`modelUsage` is the field the SDK says to use.

### 8. `wrapLine` measures UTF-16 code units, so CJK/emoji/tab content overflows the pane [verified]

`src/core/util.ts:107-138`

The doc comment states the whole reason this function exists:

> The panes do their own wrapping rather than leaning on Ink's `wrap="wrap"` because scrollback
> needs to know **exactly** how many rows a line occupies.

But every measurement is `.length`. Verified:

```
wrapLine('日本語テキストの折り返し試験です', 10) -> ["日本語テキストの折り","返し試験です"]
wrapLine('\t\t\tdeeply indented line of code here', 12)
  -> ["\t\t\tdeeply","\t\t\tindented","\t\t\tline of","\t\t\tcode here"]
```

Row 1 of the first is 10 code units but **20 terminal columns** — double the pane width. The tab
case is worse: each row is 3 tabs (up to 24 columns) plus text, in a 12-column pane. Since these
rows feed `metrics.current` → `scrollBy` (`App.tsx:683-687`), the scroll arithmetic is wrong too,
which is precisely the failure mode the comment says the hand-rolled wrapper was written to avoid.
Any agent output containing CJK, emoji, box-drawing characters or tab-indented code triggers it.
`wrapLine(text, 1)` also returns the input unwrapped (`:108`), so a very narrow terminal overflows.

### 9. `decodeChunk` silently corrupts plain command output that happens to look like base64 [verified]

`src/core/adapters/codex.ts:750-766`

```ts
if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0 && value.length > 8) {
```

The `!decoded.includes('�')` guard catches most false positives, but not all. Brute-forced
over 20,225 realistic plain-ASCII output tokens (no spaces/punctuation, length 12–20):

```
99 were silently base64-decoded into garbage (0.49%)
   "FAILEDnpmapp" => "9陪i"
   "FAILEDsrcnpm" => ";+rzf"
```

Roughly 1 in 200 such chunks is destroyed, and the user has no way to tell it happened. The
protocol knows which channel is which; guessing per-chunk from the payload is the wrong layer.

### 10. The gist from question #1 leaks into question #2 [traced]

`src/core/summarizer.ts:38`, `:71-73` · `src/core/conductor.ts:449-463`

`Summarizer.gist` is only ever written by `update()`. `Conductor.reset()` and `Conductor.clear()`
do not touch the summarizer, and `Summarizer.seed()` is **dead code** — `grep -rn 'seed(' src/`
returns only its own definition. So asking a second question in the same doet session:

- hands the note-taker a `<digest>` about the *previous* question (`relay.ts:200-207`),
- injects that stale digest into every relay prompt (`relay.ts:96-106`),
- and hands it to any session rotated with `handoff: 'gist'` (`conductor.ts:332-342`).

`/new` clears the panes, the relay log and the conductor, but not the digest — and the notice it
prints says "Both agents carried the gist", which is now the *old* question's gist.

### 11. One-off CLI model flags get silently persisted to `~/.doet/config.json` [traced]

`src/cli.tsx:141-148` · `src/ui/App.tsx:310-311, 366, 551-552, 600-601, 612-613`

```ts
// Flags win over config for this run, but are not written back — a one-off
// `--claude-model opus` should not quietly become the new default.
if (args.claudeModel) config.models.claude = { id: args.claudeModel, effort: args.claudeEffort };
```

The flags are applied by **mutating the loaded `config` object**, which is then passed to `App` and
becomes the argument to every `saveConfig(config)` call. So the moment the user runs any of
`/model`, `/summary`, `/session … policy`, `/session … handoff`, `/rounds` or `/first`, the entire
mutated object — including the one-off `--claude-model opus` — is written to disk. The comment's
promise is broken by any subsequent slash command.

---

## S3 — Correctness and robustness

### 12. Arrow keys on an empty picker produce `NaN` [verified]

`src/ui/App.tsx:717-720` · `src/ui/Picker.tsx:32`

```ts
setPickIndex((i) => (i - 1 + pick.items.length) % pick.items.length);
```

`% 0` is `NaN`. Reachable: `/models <agent>` (`App.tsx:491-506`) opens a picker from
`listModels()` **without checking for an empty list**, and both adapters return `[]` when their
model-discovery call fails (`claude.ts:112-118`, `codex.ts:159-161`) — the exact scenario the
adapters explicitly plan for. `pickIndex` becomes `NaN`, `pick.items[NaN]` is `undefined`, enter
does nothing. `pickModel` (`:261-263`) does guard for this; `/models` does not.

### 13. A gist handoff is recorded in the event log as a `full` one [traced]

`src/core/adapters/claude.ts:167-171` · `src/core/adapters/codex.ts:194-199`

```ts
this.bus.emit({ kind: 'session', agent: this.id, carried: carry ? 'full' : 'none' });
```

`carried` is typed `HandoffMode` (`'gist' | 'full' | 'none'`), but `newSession(carry)` only receives
the rendered string, so `'gist'` is never emitted. `events.jsonl` — the audit trail
`SessionStore` exists to produce — permanently mislabels every gist rotation as a full-transcript
one. The mode is known at the call site (`conductor.rotate`, `:281-291`) and simply isn't passed.

### 14. A verdict marker inside a code block is parsed and stripped [verified]

`src/core/relay.ts:19`, `:31-42`

`VERDICT_PATTERN` is applied to the raw message with no awareness of fenced blocks:

```
input:    "Here is the protocol:\n```\n<<<DOET:VERDICT REVISE>>>\n```\nDone.\n\n<<<DOET:VERDICT AGREE>>>"
parsed:   AGREE
stripped: "Here is the protocol:\n```\n\n```\nDone."
```

Any agent that quotes or documents the protocol — a plausible thing to ask two coding agents to do,
and precisely what this audit had to do — has that text silently deleted from its answer, and can
trip a false verdict. `stripVerdict` removes **all** occurrences, not just the trailing control
line, even though `parseVerdict` already treats only the last one as authoritative.

### 15. `parseSessionPolicy` accepts malformed input [verified]

`src/core/config.ts:119-129`

`value.split(':')` is destructured to two names but never length-checked:

```
"rounds:4:5"  -> {"mode":"rounds","every":4}     // trailing ":5" silently ignored
"tokens:1e9"  -> {"mode":"tokens","limit":1000000000}
"rounds:2.7"  -> {"mode":"rounds","every":2}     // silently floored
"ROUNDS:4"    -> null                            // case-sensitive, unlike "manual"
```

Compounded by `App.tsx:545`, which joins the argument list with `''` rather than `' '`, so
`/session claude policy rounds 4` becomes `rounds4` → rejected, while
`/session claude policy tokens: 120000` is accepted.

### 16. `loadConfig` trusts the shape of every value it reads [traced]

`src/core/config.ts:65-93`

Only `models` and `summary.model` are validated (via `readModel`). Everything else is spread
straight in: `debate: { ...DEFAULT_DEBATE, ...raw.debate }` will happily install
`maxRounds: "lots"` or `agreeStreak: -1`, and `sessions.claude.policy` is not checked at all, so a
hand-edited config can put `{mode:'rounds'}` with no `every` into `rotationDue()`
(`conductor.ts:317-321`), where `sessionTurns >= undefined` is always `false` — a rotation policy
that silently never fires. The `catch` at `:89` only covers JSON parse failure, not bad content.

### 17. `formatUsd(0)` reports `<$0.01` [verified]

`src/core/util.ts:67-70` — `value < 0.01` is true for `0`, so a genuinely free/unmetered turn is
displayed as if it cost money. `undefined` is handled; `0` is not distinguished.

### 18. `AgentPane` writes to a parent ref during render [traced]

`src/ui/AgentPane.tsx:80` — `onRows?.(rows.length, viewport)` is called in the component body, and
`App.tsx:862-864` uses it to mutate `metrics.current`. A side effect during render: under React 19
this can run on a discarded render or twice per commit, leaving `scrollBy` (`App.tsx:683`) paging
against stale row counts. Belongs in `useEffect`.

### 19. Streaming re-wraps the entire scrollback on every token [traced]

`src/ui/App.tsx:121-154`, `:51` · `src/ui/AgentPane.tsx:73`

Each `text`/`thinking`/`output` delta copies the whole pane array (`[...prev[agent]]`) and
`.slice(-4000)`, producing a new array identity, which invalidates
`useMemo(() => layout(lines, inner), [lines, inner])` and re-wraps **all** buffered lines. That is
O(scrollback) per streamed token, per agent, i.e. quadratic over a session — with `MAX_PANE_LINES`
= 4000 and two agents streaming concurrently. Independently, a 90 ms spinner interval
(`App.tsx:112-115`) plus a 120 ms `activeAgent` poll (`:233-236`) re-render the whole tree ~19×/s
whether or not anything changed; the poll exists only because the conductor exposes `activeAgent`
as a getter instead of emitting an event.

### 20. Session-rotation commands are not guarded against a running debate [traced]

`src/ui/App.tsx:535-542`, `:622-641` — `/session <agent> new` and `/new` call `conductor.rotate()`
with no `conductor.isRunning` check. Best case this pulls the session out from under the next
prompt; worst case it is the trigger for bug #3. `/new` additionally calls `conductor.clear()`
(`:632`) while `run()` is still executing, so `phase` is reset to `'idle'` under a live loop that
will then overwrite it.

---

## S4 — Hygiene

### 21. Publishing from a clean checkout ships a package with no `bin` [verified]

`package.json` — `bin` points at `./dist/cli.js`, `files` is `["dist"]`, `.gitignore` contains
`dist/`, and there is **no `prepare` or `prepublishOnly` script**. Simulated a fresh checkout by
removing `dist/`:

```
$ npm pack --dry-run
npm notice total files: 2
```

`npm i -g .` or `npm publish` from CI installs a `doet` command whose target does not exist.
`"build": "tsc"` exists but nothing runs it. (`README.md:46-49` tells humans to run `npm run build`
manually, which is why this has not bitten locally.)

### 22. Assorted

- **`scripts/` is never typechecked** — `tsconfig.json` `include: ["src"]`, yet `npm run typecheck`
  is what `README.md:30` cites as the project's correctness bar.
- **`Summarizer.seed()` is dead code** (`summarizer.ts:71-73`) — no caller anywhere in `src/`.
- **`DebatePhase` has a `'converged'` member that is never assigned** (`types.ts:173-180`);
  `conductor.run` goes straight from `'exchanging'` to `'synthesizing'`.
- **`SessionStore.detach()` is never called on the normal exit path** — `cli.tsx:217-219` skips it
  (only `App.shutdown()` at `:655` calls it, and that path is not taken on `app.waitUntilExit()`).
- **`AgentPane`'s `Row.first` field is computed but only consumed for `kind: 'tool'`**
  (`AgentPane.tsx:155`) — `prompt`/`output` rows all get the gutter, including continuations.
- **Missing hook dependencies**: `pickModel` (`App.tsx:302`) omits `applyModel`, `pickSummary`
  (`:362`) omits `applySummary`. Both are currently stable by luck (every dependency they close
  over is a prop or a `useCallback` with stable deps); it is a latent stale-closure bug the moment
  anyone makes `config` stateful.
- **`Picker.tsx:32` shadows the global `window`** — harmless in Node, noisy to read.
- **Unknown CLI flags are silently ignored** (`cli.tsx:79-80`), and a flag consumed as another
  flag's value is too: `doet --first --rounds 3` eats `--rounds` as the value of `--first`, then
  drops `3`. Same for an invalid `--claude-effort turbo`, which `asEffort` (`:27-29`) turns into
  `undefined` without a word.
- **`config.ts:53-56` defaults both agents to `handoff: 'ask'`, and `conductor.ts:301-307` degrades
  `'ask'` to `'gist'` when no hook is installed** — reasonable, but combined with the default
  `policy: 'manual'` it means the `askHandoff` degradation path is only reachable in headless use,
  where it is untested.

---

## Suggested order of attack

1. **#1** — a missing `codex` on PATH is the first thing a new user hits, and it hangs silently.
   Handle `close`, reject `inflight` in `stop()`, and put a timeout on `request()`.
2. **#2** — swap `allowedTools: []` for the SDK's `tools` option (or `disallowedTools`), and give
   `Summarizer.update()` a timeout so the digest can never block the conductor.
3. **#3** — settle and clear `this.turn` in `closeSession()`; guard the rotation commands.
4. **#4 / #5** — both are the conductor doing the opposite of what the README promises, and both
   are ~3-line fixes: ignore round 0's verdict; skip synthesis when `stopRequested`.
5. **#8** — pull in a `string-width`-style measurement before the panes are trusted with real
   agent output.

The first four are all in code paths with no test coverage; a handful of fake-adapter tests along
the lines of the probes used for this audit would have caught #4, #5 and #6 outright.
