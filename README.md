# doet

Two agent CLIs, one conversation.

doet is a **passer**, not an agent. It never calls a model itself and never
writes a word of the answer. You ask a question, pick who answers first, and
doet hands that agent's full response to the other one — back and forth, until
they agree or run out of exchanges.

Both agents run in panes inside doet, and **every permission prompt from either
agent surfaces in doet** with the same three keys. You approve a Codex shell
command and a Claude file edit the same way, without learning two UIs.

Each pane shows both halves of that agent's conversation — the prompt doet
handed it (`▎` gutter) and everything it said back. Text wraps, and the panes
scroll, so nothing is lost off the right edge.

Markdown is rendered, not printed: both agents write it and both their CLIs
display it, so showing raw `**asterisks**` in doet would be a step down from
either one. Wrapping is measured on the rendered width — `**Goal**` is eight
columns of source and four on screen — so lines fill the pane instead of
breaking early.

```
┌ Claude Code  sonnet/high      ready · 3.8k ┐┌ Codex  gpt-5.6-sol/low  working · 1.8k ┐
│ ▼ doet → claude · opening                  ││ Checking the cited files…              │
│ ▎ You are Claude Code, taking part in a    ││ Claude's core claim is correct, but it │
│ ▎ two-agent working session run by `doet`. ││ exceeds the 120-word limit.            │
│ Relay only the latest message when each    ││                                        │
│ agent keeps a persistent session.          ││                                        │
│ ⏵ Bash npm run typecheck                   ││                                        │
└────────────────────────────────────────────┘└────────────────────────────────────────┘
 gist claude · haiku · 1–4/8 · ↑↓ scroll                            ctrl+g relay log
 **Goal** — Decide whether the relay should carry the full transcript each round.
 **Settled** — Both adapters hold a persistent session, so each agent already
 remembers its own turns. `npm run typecheck` passes clean.

╭──────────────────────────────────────────────────────────────────────────────────╮
│ Codex wants to run Shell command                                                 │
│ /bin/zsh -lc 'npm run typecheck'                                                 │
│ Verifying the claim that the project typechecks cleanly.                         │
│ [a] Allow once   [s] Allow for session   [d] Deny                                │
╰──────────────────────────────────────────────────────────────────────────────────╯
```

## Install

Needs Node 20+, plus the `claude` and `codex` CLIs on `PATH` and already
logged in.

Install from a clone kept somewhere other than where you work on doet, so the
doet you use does not change under you while you are changing it:

```bash
git clone https://github.com/BeerJii/doet.git ~/.doet-src
cd ~/.doet-src
npm install       # builds on install, via prepare
npm link          # puts `doet` on your PATH
```

To update, pull and rebuild:

```bash
cd ~/.doet-src && git pull && npm install
```

`npm i -g github:BeerJii/doet` does **not** work. npm runs `prepare` in a
temporary clone that has no devDependencies, so there is no `tsc` to build
with and the install fails on exit 127.

To work on doet, clone it wherever you keep your work and run it from source
with `npm run dev`. That reads `~/.doet-dev`, not the `~/.doet` your installed
copy uses, so the two cannot disturb each other.

## Use

```bash
doet                                  # in the directory you want the agents to work in
doet --rounds 8 --first codex
doet -C ~/projects/api --claude-model opus --claude-effort high
doet --summary codex --summary-model gpt-5.4-mini

doet --sessions                       # what you have to come back to
doet --resume                         # reopen the latest session here
doet --resume 2026-08-07T09-09-48     # or a specific one, by id or prefix
```

Type a question, press enter, pick `[1]` Claude or `[2]` Codex to answer first.
Then watch. While a debate runs, anything you type becomes a note delivered to
the next agent before its turn.

| Key | |
|---|---|
| `enter` | send |
| `a` / `s` / `d` | answer a permission prompt |
| `←` / `→` | select a pane — works while a turn is running; `tab` cycles |
| `ctrl+o` | **open the selected pane's session** — branch it, or take it over |
| `↑` / `↓` | scroll the selected pane — or walk command history when none is selected |
| `pgup` / `pgdn` | page the selected pane |
| `ctrl+e` | zoom the selected pane to full width |
| `ctrl+g` | switch the bottom band between the relay log and the gist |
| `esc` | release the pane, or end the debate after the current turn |
| `ctrl+x` | abort the current turn now |
| `ctrl+c` | quit |

### Commands

| | |
|---|---|
| `/open <agent>` | branch it, or take it over here — same as `ctrl+o` |
| `/where` | where branched sessions should open |
| `/model` | pick an agent, then a model, then an effort |
| `/model <agent>` | jump straight to that agent's list |
| `/model <agent> <model> [effort]` | set it directly |
| `/models <agent>` | browse what that agent actually accepts |
| `/summary` | choose who keeps the gist, and on what model |
| `/gist` | show the running digest |
| `/session <agent> new` | fresh session for one CLI |
| `/session <agent> policy …` | `manual` · `rounds:N` · `tokens:N` |
| `/session <agent> handoff …` | `ask` · `gist` · `full` · `none` |
| `/perm <agent> <mode>` | permission posture — see below |
| `/rounds <n>` | re-cap the debate |
| `/first <agent>` | default opener |
| `/stop` | end after the current turn |
| `/new` | fresh doet session, both agents rotated |
| `/quit` | exit |

Everything you set this way persists to `~/.doet/config.json`.

## Opening a session in its own CLI

Select a pane with `←` / `→` and press `ctrl+o`. There is no terminal hiding
behind a pane to attach to — doet drives these CLIs over protocols, not a TTY
(the Agent SDK for Claude, the app-server for Codex), which is what makes one
normalized permission prompt possible in the first place. What the two sides do
share is a session id.

Neither CLI lets two processes write one session, so there are exactly two
honest things doet can do, and `ctrl+o` asks which one you want:

**Branch it into a new window** — nothing stops. The agent keeps working, doet
keeps running, and a new window opens on a *copy* of the conversation. Use this
to go poke at what an agent knows while the session carries on without you.

```
 ctrl+o ──► branch ──► new window: claude --resume <id> --fork-session
                                   codex  resume <forked-id>
            doet's own session: never touched, never paused
```

**Take it over here** — doet steps aside and gives you this terminal, on the
*same* session. Everything you do comes back when you quit. This is the one
that stops things: doet has to let go of the session, so if a turn is running
it is interrupted and the session ends.

|  | branch | take over |
|---|---|---|
| the agent | keeps working | interrupted |
| doet | keeps running | steps aside |
| which session | a copy | the same one |
| your work there | stays there | comes back |

### Where a branch opens

**doet asks once**, the first time you branch, and remembers the answer in
`~/.doet/config.json`. `/where` changes it later. It offers whatever actually
works on your machine, plus one option that always does:

| | |
|---|---|
| **Just give me the command** | doet copies it to your clipboard and prints it in the pane. You open a terminal wherever you like and paste. |
| a new tmux window | only when doet is running under tmux |
| a new WezTerm / kitty window | when that terminal is running and reachable |
| a new Terminal / iTerm window | macOS |

The reason "give me the command" exists — and why it is offered first inside an
editor — is that **no editor lets a child process open a new integrated
terminal**. There is no API for it in VS Code or Cursor. So when doet is running
in an editor panel, the only things it can launch on its own are a tmux window
(which stays put, if you have tmux) or a separate GUI window (which does not).
Handing you the command sidesteps the whole problem: you open a split in your
editor and paste, and the branch lands exactly where you wanted it.

`npx tsx scripts/probe-launcher.ts` prints what is available in each
environment.

Codex needs one wrinkle worth knowing about: whichever app-server calls
`thread/fork` becomes the branch's active writer, Codex permits exactly one, and
`thread/unsubscribe` does not release it — so a branch cut by doet's own server
is refused to the new window with *"already has an active writer"*. doet cuts it
with a throwaway app-server instead, which is stopped immediately and takes its
lock with it.

### Getting back

Quit the CLI you were handed — `ctrl+d`, `/exit`, or `ctrl+c` twice — and doet
redraws with that session re-attached. doet prints exactly this before stepping
aside, so the screen never just becomes another CLI with no way back:

```
────────────────────────────────────────────────────────────────
 doet handed this terminal to Codex.
 codex resume 019fdb7c-5847-7852-9ad7-a9d0cdbc9b64

 Quit that CLI when you are done — ctrl+d, /exit, or ctrl+c twice —
 and doet comes back with this session and everything you did in it.
────────────────────────────────────────────────────────────────
```

If doet itself is gone — you quit it, or it fell over — `doet --resume` reopens
the last session for this directory and re-attaches **both** agents to the
sessions they were on. `doet --sessions` lists what is there. Every run prints
its own resume command on exit.

Worth knowing:

- **Both work mid-turn.** A branch costs the running session nothing at all. A
  takeover interrupts the current turn and skips the closing deliverable — doet
  says so before you choose. Both sessions survive either way, so you can ask
  again afterwards and both agents remember the detour.
- **One handover at a time.** A second `ctrl+o` while one is still being set up
  is refused rather than acted on — suspending an already-suspended terminal is
  an error, and an unhandled one used to take doet down mid-handover.
- **Codex is ready immediately; Claude needs one turn first.** Codex gets its
  thread id at startup, while Claude's session id only exists once the session
  has something in it. Before then, `ctrl+o` says so rather than guessing.
- The pane records the handover, and `session.md` keeps whatever the agents
  said afterwards — but what you typed in the takeover lives in that CLI's own
  history, not in doet's transcript.

## Picking a model

`/model` with no arguments walks you through it: which agent, then which model,
then how hard it should think. Both lists come from the CLI itself — Claude
through the Agent SDK's `supportedModels()`, Codex through `model/list` — so
they reflect what your account can actually run, with the display names and
descriptions each vendor ships. A model your plan does not include is rejected
by doet with the list of ones it does, rather than by the provider with a 400 on
the first turn.

Reasoning effort is part of the same choice, because on both CLIs it is part of
the model: only the levels a given model supports are offered. Codex applies
both as overrides on every `turn/start`; Claude switches with `setModel` and
`applyFlagSettings`.

The id you pick and the id the CLI resolves it to are tracked separately —
picking `sonnet` shows `sonnet`, not `claude-sonnet-5`, so what you chose is
still what you see and what gets saved.

## The summary agent

Something keeps one running digest — goal, what is settled, what is still open,
what happens next. It is rewritten after every exchange, so a long session stays
comprehensible instead of being a chain of replies-to-replies.

**The digest is for you, not for the agents.** It appears in the band under the
panes as soon as it is written — no keypress, since a digest nobody reads is not
worth paying a third agent for. `ctrl+g` switches back to the relay log, and
once you pick a band yourself new notes stop taking it from you. It is also
saved to `gist.md`.

It is *not* injected into relays: both agents hold persistent sessions and
already remember everything, so notes there would be doet paraphrasing them back
at themselves, and on the first exchange they say nothing but "nothing yet". The
one exception is briefing a session that has genuinely lost its memory — a
rotation, or `--resume`.

doet asks **at the start of every session** who should write it — Claude, Codex,
or nobody — with last time's answer already under the cursor, so confirming is
one keystroke. It is not asked once and remembered forever: a note-taker is a
third agent burning tokens on every exchange, and whether that is worth it
depends on the session you are about to have. `--summary claude|codex|off` skips
the question; `/summary` re-opens it.

**It always runs in its own session.** Never one of the two working agents:
a digest written inside a working session would be a turn in that agent's
history, which is the one thing those sessions are kept clear of.

Each exchange, doet sends it **both agents' messages together** — a digest
written from half an exchange is written before the reply that answers it.

A dedicated summarizer runs on **its own session and its own event bus**. Both
matter: a separate session means summarizing never pollutes either debater's
context or burns one of their turns, and a separate bus means its tokens and
tool calls never appear in the two panes.

It also has no tools, and that is enforced by refusing every tool call outright
rather than by configuration. Running on a private bus means a permission prompt
from it would be seen by nobody and answered by nobody, so it would hang the
agent and the session waiting on it. (`allowedTools: []` does *not* achieve
this — that option is an auto-approve allowlist, not a restriction.) As a
second backstop, a session waits at most 90s for a digest before carrying on
without it.

The digest is written after every exchange, including the last one, and each
update logs a line in the relay band so you can tell it happened — `ctrl+g`
reads it.

This is the one place doet calls a model on its own behalf. It never writes a
word of the answer.

## How many exchanges

doet asks every time you send a question, right after you pick who answers
first — because the right number is a property of the question, not of the
session. "Check this one-liner" and "rewrite this module" do not want the same
cap, and choosing when you ask beats remembering to set it beforehand.

Your last choice becomes the default offered next time. `/rounds <n>` and
`--rounds <n>` set that default; they do not remove the question.

## Sessions

Each agent's session is long-lived, which is what lets round 5 remember round 1.
It is also what makes them drift and get expensive. `/session <agent> new`
retires one and opens a fresh one; `/session <agent> policy rounds:6` or
`tokens:150000` does it on a schedule.

Whenever a session is retired, doet asks what the replacement should carry:

- **the gist** — the summary agent's digest. Small, and usually enough.
- **the complete session** — everything said so far, verbatim. Faithful, but
  you re-pay for every token.
- **nothing** — a clean slate.

`/session <agent> handoff gist` answers that question ahead of time so an
automatic rotation does not stop to ask. The handoff rides in front of the next
prompt rather than being sent as a turn of its own, so it costs no extra
round-trip, and it is framed as a briefing: the new session is told to re-check
what matters rather than trust a summary of it.

`/new` starts a fresh doet session and asks the same question once for both
agents — the panes clearing while the agents still remember everything is
exactly the confusion that used to cause.

## How a session ends

It runs the number of exchanges you picked, then **both agents stop**. Nothing
further is sent to either one.

Their sessions stay open. Send another message and doet asks who receives it —
that agent picks up in the same session, remembering everything. So a session is
a series of these: you ask, they trade a set number of exchanges, they stop, you
read, you ask again. `esc` or `/stop` ends a run sooner.

**The last reply is the answer.** doet does not ask for a closing deliverable,
because every reply is already written as the finished answer — each agent is
told its reply should stand on its own. Asking again spent a turn restating what
had just been said, and it was the one place doet put a block of its own
instructions in front of an agent.

That is removed, not made optional. It was briefly a config flag, which meant
`~/.doet/config.json` files written before the change kept the old behaviour
alive — the code said one thing and the machine did another. `loadConfig` now
reads `debate` field by field for the same reason: a key for behaviour that no
longer exists cannot bring it back.

The agents are also not asked to emit any status marker. doet used to have them
end each turn with `<<<DOET:VERDICT AGREE|REVISE>>>` so it could detect
convergence, and it stripped that before saving — but not before it appeared in
the agent's own session, which is yours to read and take over. Deciding when to
stop is your job now, which is why doet asks how many exchanges you want each
time you send a question.

## How it works

```
                    ┌──────────────┐      ┌──────────────┐
   your question ──►│  Conductor   │─────►│  Summarizer  │  own session,
                    │ turn-taking  │◄─────│  the gist    │  own bus
                    └──────┬───────┘ gist └──────────────┘
                           │  normalized events + permission requests
                    ┌──────▼───────┐
                    │     Bus      │──► TUI (two panes, relay log, gist)
                    └──────┬───────┘──► SessionStore (~/.doet/sessions/<id>/)
              ┌────────────┴────────────┐
      ┌───────▼────────┐       ┌────────▼───────┐
      │ ClaudeAdapter  │       │  CodexAdapter  │
      │ Agent SDK,     │       │  JSON-RPC over │
      │ streaming input│       │  app-server    │
      └───────┬────────┘       └────────┬───────┘
          `claude`                   `codex`
```

Everything above the adapters speaks one vocabulary (`src/core/types.ts`), so
adding a third agent means writing one adapter and touching nothing else.

**Claude Code** runs through `@anthropic-ai/claude-agent-sdk` in streaming-input
mode. Its `canUseTool` callback is the permission bridge — it blocks until you
answer in doet. Streaming input is also what keeps one session alive across
every round, so round 5 still remembers round 1.

**Codex** runs through `codex app-server`, the JSON-RPC protocol its own desktop
and IDE clients use. `codex exec --json` would have been simpler but it is
one-shot and *cannot ask you anything* — approvals there are resolved by policy,
not by a human. Since doet exists to put both agents' prompts in front of you,
the app-server is the only honest option. Its five approval request types
(`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
`item/permissions/requestApproval`, `item/tool/requestUserInput`,
`mcpServer/elicitation/request`) all normalize into the same prompt.

### What each agent actually receives

doet's framing is sent **once**, as the agent's own session instructions —
appended to Claude Code's system prompt, and as Codex's `developerInstructions`.
After that, a turn is the message and nothing else:

```
turn 1  →  what is this repo about          ← exactly what you typed

turn 2  →  <request>
             what is this repo about
           </request>

           Answer by Claude Code:

           <claude>
             …Claude's reply, unaltered…
           </claude>

turn 3  →  Answer by Codex:

           <codex>
             …Codex's reply, unaltered…
           </codex>
```

That is the whole prompt in each case — nothing else is added, ever. No task
appended to a relay: what to do with the other agent's answer never changes
round to round, so it lives in the session instructions, and repeating it on
every hand-off would be doet talking over the agent it is quoting. No running
notes: both agents remember their own sessions. No status marker to emit, and
no closing "now write the final version" turn. Later rounds drop the request
too, since only a newcomer needs it restated.

Run `npx tsx scripts/probe-prompts.ts "your question"` to see the exact text of
every turn type, with word counts.

Because each adapter holds a persistent session, a relay carries only the other
agent's **latest** message, not the whole transcript. Re-sending everything each
round would burn tokens and invite the models to repeat themselves. The summary
agent's gist rides along as background, clearly marked as doet's compression
rather than the counterpart's words — an agent's own memory of its turns stays
authoritative over it.

### Permission posture

`/perm claude <default|acceptEdits|plan|bypassPermissions>`
`/perm codex <untrusted|on-request|never>` or `<read-only|workspace-write|danger-full-access>`

doet ships Codex on `untrusted` + `workspace-write`, the combination that
actually produces prompts. Loosening either one silently removes the thing doet
is for. "Allow for session" is remembered by doet, not written into either
CLI's own rule store, so it expires when you quit and leaves no residue in your
settings files.

### What lands on disk

One directory per run, written as it happens rather than at the end:

```
~/.doet/sessions/<stamp>-<id>/
  session.md     the conversation, appended turn by turn
  claude.md      that agent's own transcript
  codex.md
  gist.md        the summary agent's latest digest
  meta.json      the agent session ids, for `doet --resume`
  events.jsonl   every event, including permission decisions
```

Live, not write-once, because the markdown is not only a record — a `full`
handoff reads `session.md` back to brief a replacement session, and a file that
only appeared when a debate ended could not do that. `meta.json` is rewritten
whenever a session id or model changes, for the same reason: the run that most
needs to be resumable is the one that never reached a clean exit.

`DOET_HOME` moves all of it, config included. `npm run dev` sets it to
`~/.doet-dev` on purpose: developing doet with doet is the normal case here,
and a branch build sharing `~/.doet/config.json` with an installed doet writes
config keys back that only make sense on the branch.

`--resume` reopens the same directory and keeps appending to it, and it prefers
the models the session was actually using over whatever your config says now.
If one of the stored agent sessions can no longer be opened, that agent starts
fresh and says so rather than failing the whole resume.

## Development

```bash
npm run dev                                    # run from source, DOET_HOME=~/.doet-dev
npm run dev -- --cwd ~/somewhere               # note the --, or npm eats the flags
npm run typecheck
node scripts/probe-codex.mjs                   # codex handshake only
node scripts/probe-models.mjs                  # what models your account has
npx tsx scripts/probe-prompts.ts "question"    # exactly what each agent is sent
npx tsx scripts/probe-launcher.ts              # where a branch would open, per environment
npx tsx scripts/probe-markdown.ts              # inline markdown parsing and wrap widths
npx tsx scripts/probe-select.ts [claude|codex] # model + effort + session rotation
npx tsx scripts/probe-debate.ts "question" 4   # full debate, no TUI, auto-approves
npx tsx scripts/probe-handoff.ts [gist|full]   # rotate mid-debate, inspect the handoff
npx tsx scripts/probe-resume.ts                # release a session and get it back
npx tsx scripts/probe-reopen.ts                # `doet --resume` end to end
npx tsx scripts/probe-fork.ts [claude|codex]   # branch, and prove the live one is untouched
npx tsx scripts/probe-takeover.ts [claude|codex|midturn]   # the full handover
script -q /dev/null npx tsx scripts/probe-suspend.tsx      # Ink hands over a real tty
npx tsx scripts/probe-ui.tsx [debate|picker|gist|wrap|focus|takeover]   # one TUI frame
```

`probe-takeover` runs the agent's own CLI in the middle of the round-trip
(headless, standing in for you at the keyboard) and checks that a word learned
*during* that detour comes back into the re-attached session. `midturn` covers
the race that matters: aborting a live turn and releasing the session without
the conductor still awaiting it. `probe-suspend` needs a real tty — hence
`script`.

`probe-debate` and `probe-handoff` auto-approve every permission request so they
can run unattended — they prove the round-trip works, but the TUI is what puts a
human in that seat.

`probe-ui` drives the real `App` against stub agents through a fake stdin, so
layout, wrapping and the pickers can be checked without a TTY or a model call.
Ink pulls input with `read()` after a `readable` event and swallows the first
200ms while probing for the kitty keyboard protocol, which is why that stub is a
small queue rather than a bare `EventEmitter`.

## Limits

- Two agents, fixed: Claude Code and Codex. The summary agent is one of the
  same two, on its own session.
- A pane is a view, not a terminal. `ctrl+o` either opens the real CLI in a new
  window or hands you this one; it does not embed a terminal in the pane.
- Taking a session over ends the current session rather than pausing it.
  Branching is the option that leaves everything running, and the price is that
  the branch is a copy — work done there does not flow back.
- Branching needs tmux or macOS. Elsewhere only the takeover is offered.
- Both agents share one working directory, and both can edit files in it. Two
  agents editing the same file in the same round can clobber each other — doet
  shows you every write, but does not lock anything.
- `--resume` reopens agent sessions, not doet's own screen: the panes come back
  empty, with the gist restored and the transcript on disk. Both agents still
  remember everything.
- A `full` handoff sends the whole session as one message. On a long debate
  that is a large prompt, and doet does not check it against the model's
  context window first.
