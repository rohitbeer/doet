# doet

Several coding agents, two ways to work.

doet drives four CLIs, and adding the next one is a file rather than a change
everywhere:

| | | effort dial | bring your own key | forkable session |
|---|---|:-:|:-:|:-:|
| `claude` | Claude Code | ● | | ● |
| `codex` | Codex | ● | | |
| `cline` | Cline | ● | ● | |
| `kilo` | Kilo | | ● | ● |

Any of them can take any slot, including the same one in several slots at once.
What differs between them is not hidden: a CLI with no reasoning dial is never
asked for an effort, and one whose session cannot be copied says so rather than
offering you a fork it would have to fake.

doet has two modes:

- **co-code** is the original passer: one agent answers, doet hands the full
  response to the other, and they review each other for the number of exchanges
  you choose. Any two CLIs, including two of the same — Claude against Claude is
  a real comparison, and the slot letter keeps them apart.
- **vs** sends the exact same task to **up to nine** independent sessions, each
  in its own git worktree cut from the branch you are on. Every agent starts
  from exactly what you had and none of them can see another's work. doet reports
  what each one spent getting there — time, tokens, cost — and lets you message
  any of them on its own, mid-run or between runs, without the others hearing it.

Past two agents there is no room to show them side by side, so a vs run gives
doet the whole terminal and files each agent in a window of its own:

```
 doet · vs · 5 agents · ⠹ all 5 working · Type a request — all 5 agents get it
 ── ⠹ running · 2m 14s wall clock ──
 ❯ A Claude Code    1m 58s ·  24.1k in ·  3.2k out · $0.41 · 4f +180 −22
   B Codex          2m 14s ·  31.0k in ·  2.8k out · –     · 3f +96 −14
   C Kilo           1m 02s ·  18.4k in ·  1.9k out · $0.07 · 2f +64 −8
   D Cline          2m 09s ·   9.2k in ·  1.1k out · –     · 5f +210 −41
   E Claude Code    1m 44s ·  22.7k in ·  2.4k out · $0.36 · 4f +171 −19
```

`↑` `↓` walks the list. `enter` opens that agent's window and you watch it work
at the full width of your terminal. `w` opens its **worktree** with its session
forked into it — a copy of everything that agent has read and done, in the
checkout it did it in, while the run carries on undisturbed.

Every agent runs as its real terminal program in a real tmux pane, rendering
itself, exactly as if you had started it yourself. Its permission prompts are
its own and you answer them in its own pane — doet does not stand in the way,
and does not try to redraw a UI each CLI already has.

What doet knows about a run it reads from the record each CLI keeps, not from
the screen. Claude and Codex write a transcript per session; cline and kilo keep
theirs in SQLite. Either way the question is the same — has a turn finished,
what did it say, what did it cost — and where the answer comes from is the
adapter's business. See `src/core/agents/`.

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

Needs Node 20+, plus whichever agent CLIs you intend to use on `PATH` and
already logged in. doet checks before it builds anything and names the ones it
cannot find, rather than letting a pane die during startup in a window you have
not attached to yet.

```bash
npm i -g cline @kilocode/cli     # the two that are not already yours
```

Node 22.5+ is worth having even though 20 works. cline and kilo keep their
sessions in SQLite, and on 22.5+ doet reads those databases directly through
`node:sqlite` — about 8ms a read. Below that it falls back to asking the CLI
itself, which is the supported route and around 1.5 seconds a read, so a run is
a beat less responsive and nothing else changes.

Install from a clone kept somewhere other than where you work on doet, so the
doet you use does not change under you while you are changing it:

```bash
git clone https://github.com/BeerJii/doet.git ~/.doet-src
cd ~/.doet-src
npm link          # puts `doet` on your PATH
```

There is no `npm install` in that list and no build step, because there is
nothing to fetch and nothing to compile. `dist/doet.mjs` is committed, and
`ink`, `react` and their trees are compiled into it — one file, no
`node_modules`, no compiler. A clone is runnable on a machine that has Node and
nothing else, offline.

To update:

```bash
cd ~/.doet-src && git pull
```

`npm link` does not need repeating: it symlinks the bundle, so a pull is the
whole update.

The trade is that the bundle is generated code kept in git, so it goes stale if
`src/` changes without it. `npm run build` rebuilds both it and the `tsc`
output, and it is what `prepare` runs when the dev dependencies are present.
Commit `dist/doet.mjs` with any change to `src/`.

To work on doet, clone it wherever you keep your work and run it from source
with `npm run dev`. That reads `~/.doet-dev`, not the `~/.doet` your installed
copy uses, so the two cannot disturb each other.

## Use

```bash
doet                                  # pick co-code or vs at launch
doet --mode co-code                   # the original relayed conversation
doet --mode vs                        # isolated implementations, one per agent
doet --mode vs --agents 5             # five of them, each in its own worktree
doet --ui modern                      # agents filed under their names, not on screen
doet --rounds 8
doet -C ~/projects/api --model claude=opus --effort claude=high
doet --model kilo=anthropic/claude-opus-4 --provider kilo=anthropic
doet --model cline=claude-opus-4 --provider cline=anthropic --effort cline=xhigh

doet --sessions                       # what you have to come back to
doet --resume                         # reopen the latest session here
doet --resume 2026-08-07T09-09-48     # or a specific one, by id or prefix
```

In co-code, type a question, press enter, then pick who answers first. While an
exchange runs, anything you type becomes a note delivered before the next turn.

In vs, say how many agents you want, then choose each one in turn: which CLI,
whose credentials, which model, how hard it should think. Each question is
skipped when that CLI has no answer to give — Claude and Codex have one provider
and publish no model list, so choosing either asks nothing more and takes the
model from your config. kilo lists 288 models across a dozen providers, which is
exactly why it asks whose account is paying before it asks which model.

Then enter one task. Every session runs concurrently on a branch cut from the
tip of the branch you were on. Walk the list with `↑` / `↓`; `enter` opens that
agent's window, `w` opens its worktree with the session forked, `tab` addresses
it alone, and `p` squashes its branch into the main tree and keeps that agent
working there. Plug-in commits keep the main tree clean, so a second result can
be stacked afterwards. Follow-up turns are committed and appended to the session
Markdown.

A band at the top counts what each agent is spending as it spends it — time,
tokens in and out, and cost — and settles into the final comparison when the
last one finishes. See [What a run costs](#what-a-run-costs).

`tab` addresses one agent, so `enter` then sends to it alone — into the exchange
it is running, or as a turn of its own if it is idle, but always to that agent
and always straight away. See [Messaging one slot](#messaging-one-slot).

| Key | in a vs run |
|---|---|
| `↑` / `↓` | move between agents |
| `enter` | with an empty composer, open the selected agent's window |
| `w` | open its worktree, with its session forked into it |
| `tab` | address the selected agent alone |
| `p` | squash its branch into the main tree |
| `x` | abort a merge that stopped in conflict |
| `esc` | clear the address, or stop the current turn |
| `F1`–`F9` / `F12` | jump to an agent's window, or back to doet |
| `ctrl+c` | quit; branches and worktrees are kept |

| Key | |
|---|---|
| `enter` | send; with a pane selected, enter its live session |
| `m` | with a pane selected, message that slot alone — now |
| `a` / `s` / `d` | answer a permission prompt |
| `←` / `→` | select a pane — works while a turn is running; `tab` cycles |
| `ctrl+o` | enter the selected pane's current live session |
| `↑` / `↓` | scroll the selected pane — or walk command history when none is selected |
| `pgup` / `pgdn` | page the selected pane |
| `ctrl+e` | zoom the selected pane to full width |
| `ctrl+g` | switch the bottom band between the relay log and the gist |
| `esc` | release the pane, or end the co-code exchange after the current turn |
| `ctrl+x` | abort the current turn now |
| `ctrl+c` | quit |

### Commands

| | |
|---|---|
| `/open <agent>` | enter its live session here — same as `ctrl+o` |
| `/branch <agent>` | fork a co-code session into another terminal |
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
| `/rounds <n>` | re-cap the co-code exchange |
| `/first <agent>` | default opener |
| `/stop` | end after the current turn |
| `/new` | fresh doet session, both agents rotated |
| `/quit` | exit |

Everything you set this way persists to `~/.doet/config.json`.

## Interfaces

There are two, and the difference is only what is on your screen. The agents are
the same real CLIs in the same real terminals either way.

**interactive** is the original. Both agents are live, either side of doet, and
you watch the work happen. Nothing is hidden, and nothing needs opening — at the
cost of each agent getting a third of your terminal to render into.

**modern** gives doet the whole terminal and files each agent in a tmux window of
its own, named but not shown. What you read is the shape of the conversation:

```
 doet · co-code · exchange 2/4 · Claude Code answers first · 4 exchanges
   Claude Code F1 sonnet · 12.4k   ▸ Codex F2 gpt-5 · 8.1k ⚠ waiting for you
 ───────────────────────────────────────────────────────────────────────────────
 you              refactor the auth module
   Claude Code    ◀── you           read 3 files, rewrote auth.ts
 ▾ Codex          ◀── Claude Code   ⠹ deliberating…
```

Each agent line is a door. Click it, or walk to it with `↑`/`↓` and press `tab`,
and you are in that session — the real one, with its scrollback and its composer,
at the full width of your terminal, which is what it has been rendering at all
along.

You do not close an agent to leave it; it goes on running and you switch away.
`F12` returns to doet from anywhere, `F1` and `F2` go straight to an agent —
including from inside the other one — and each agent's border carries the way
back, since once you are in there doet's own screen is not visible to remind you.
`alt+0` / `alt+1` / `alt+2` are bound to the same windows, and tmux's prefix
(`ctrl+b` then a window number) always works. Prefer the function keys: on a
stock macOS terminal Option is not Meta, so `alt+…` does nothing until you enable
it — `terminal.integrated.macOptionIsMeta` in VS Code and Cursor, Left Option →
`Esc+` in iTerm2, "Use Option as Meta Key" in Terminal.app.

The one thing the modern view has to do for you is notice when a hidden agent has
stopped. co-code runs with permission prompts on, and an agent waiting for your
approval in a window you cannot see looks exactly like an agent thinking hard. So
when both the transcript and the pane have been still for six seconds, its name is
flagged `⚠ waiting for you`. It is a guess — doet reads transcripts, it does not
watch panes — but it is the difference between looking and waiting.

Choose it at launch, with `--ui`, or in `~/.doet/config.json`; whatever you pick
is remembered. Modern is co-code only for now — a VS run says so and opens the
interactive layout.

Clicking needs mouse reporting, which means your terminal's own text selection is
off inside doet's pane while it runs. Hold `option` (or `shift`) to select as
usual.

## Messaging one slot

The composer at the bottom addresses every agent at once, because that is what
makes a VS run a comparison. Sometimes you need the opposite: to say something
to *one* agent, in its own session, about its own branch — a correction to slot
A that would corrupt the comparison if the others heard it too.

Select the slot and press `m`. What you type goes to that slot and no other, and
it goes **now**. Nothing is saved for later and nothing is attached to whatever
the shared composer sends next.

What that means depends only on whether that slot happens to be working, and you
do not have to know in advance which:

| | |
|---|---|
| **busy** | it joins the exchange in flight. `message added to this exchange` means it went straight into the running session (Claude Code reads input on a live stream); `message queued` means Codex's protocol has no channel into a running turn, so doet sends it the few seconds later when that turn ends. Either way the exchange stays open until the agent has answered it, so the reply, diff, time and tokens you get back cover the request *and* the amendment as one result. |
| **idle** | it is simply that slot's next turn, opened immediately. The pane goes to work, the result is committed to that slot's branch, and the board updates. |

Two minutes into a run you notice slot A has misread the task: `m`, say so, and
it folds that into the work rather than finishing the wrong thing. After a run,
`m` on either slot is how you iterate on one implementation without touching the
other — which is a different thing from `plug`, since the slot stays on its own
branch.

Interrupting a turn drops a queued message that has not been sent yet, since the
work it was amending has stopped.

Claude Code decides for itself what to do with a message pushed into a live
session, and does not say which it chose: it either answers in a turn of its own
or folds the message into the loop it is already running. doet handles both by
watching for the stream to go quiet rather than assuming a second reply is
coming — so when it was folded in, that slot sits for about ten seconds after
the work is done before doet calls the exchange finished and commits. It shows
up in that slot's reported time; the `+1 msg` beside it is why.

Each message is recorded in `session.md` with how it landed, because one the
agent read mid-turn steered work already under way and one sent to an idle agent
started work of its own, and later that is the only place the difference still
exists.

## What a run costs

Every VS run reports what each slot spent: wall-clock time, tokens in and out,
and cost. It counts up live under the panes rather than appearing at the end,
because "this side is taking twice as long" is worth knowing while there is
still time to do something about it. The same table is written to `result.md`.

Time is per exchange, not since launch, so a slot you left idle does not look
busy. The run's wall clock is the slower slot rather than the sum — both ran at
once, and adding them would describe a race nobody ran.

Cost is the part doet refuses to guess at. Claude Code reports what a session
cost and doet shows that figure. Codex reports tokens and no cost at all, so its
cell reads `–` until you say what its model is worth:

```jsonc
// ~/.doet/config.json — USD per million tokens
{
  "pricing": {
    "gpt-5": { "input": 1.25, "output": 10 }
  }
}
```

Keys match a model id exactly, or as a prefix — one `claude-sonnet-5` entry
covers every dated variant of it. Anything doet worked out this way is shown
with a `~`, so an estimate never reads as a figure the CLI reported. doet ships
no built-in price list on purpose: prices change, doet cannot verify them, and a
confidently wrong dollar amount is worse than an honest blank.

## Opening a session in its own CLI

Select a pane with `←` / `→` and press `enter` or `ctrl+o`. There is no terminal hiding
behind a pane to attach to — doet drives these CLIs over protocols, not a TTY
(the Agent SDK for Claude, the app-server for Codex), which is what makes one
normalized permission prompt possible in the first place. What the two sides do
share is a session id.

Neither CLI lets two processes write one session. doet therefore releases the
session before starting the real interactive CLI, then resumes that same id
when you exit. Work done there comes back into the pane. Forking is a distinct
co-code action under `/branch`, so it never stands between pane selection and
the current session.

**Branch it into a new window (`/branch`)** — nothing stops. The agent keeps
working, doet keeps running, and a new window opens on a *copy* of the
conversation. Use this to go poke at what an agent knows while the session
carries on without you.

```
 /branch ──► new window: claude --resume <id> --fork-session
                                   codex  resume <forked-id>
            doet's own session: never touched, never paused
```

**Take it over here (`enter`, `ctrl+o`, `/open`)** — doet steps aside and gives
you this terminal, on the *same* session. Everything you do comes back when you
quit. If a turn is running, that slot's turn is interrupted before handover.

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
alive — the code said one thing and the machine did another. `loadConfig` reads
the legacy `debate` key for compatibility but writes it back as `coCode`.

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

VS runs use that same sessions directory, with `a.md`, `b.md`, `result.md` and
mode/slot/branch/worktree metadata in `meta.json`. `result.md` carries the
diffstats and a **Spend** table — time, tokens and cost per slot. Messages you
sent to a single slot are in `session.md`, each with how it reached the agent.
Their checkouts live under `~/.doet/worktrees/<session>/`; worktrees and
branches remain after exit unless you choose the confirmed **Discard artifacts**
action, so they can still be tested without risking an accidental cleanup.

Live, not write-once, because the markdown is not only a record — a `full`
handoff reads `session.md` back to brief a replacement session, and a file that
only appeared when a debate ended could not do that. `meta.json` is rewritten
whenever a session id or model changes, for the same reason: the run that most
needs to be resumable is the one that never reached a clean exit.

`DOET_HOME` moves all of it, config included. `npm run dev` sets it to
`~/.doet-dev` on purpose: developing doet with doet is the normal case here,
and a branch build sharing `~/.doet/config.json` with an installed doet writes
config keys back that only make sense on the branch.

For co-code sessions, `--resume` reopens the same directory and keeps appending to it, and it prefers
the models the session was actually using over whatever your config says now.
If one of the stored agent sessions can no longer be opened, that agent starts
fresh and says so rather than failing the whole resume.

## Development

```bash
npm run dev                                    # run from source, DOET_HOME=~/.doet-dev
npm run dev -- --cwd ~/somewhere               # note the --, or npm eats the flags
npm run typecheck
node scripts/probe-codex.mjs                   # codex handshake only
node scripts/probe-codex-roots.mjs             # compare worktree-root protocol options
node --import tsx scripts/probe-codex-worktree.ts  # real VS Codex startup in a worktree
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
node --import tsx scripts/probe-git.ts                     # worktree/merge semantics
node --import tsx scripts/probe-vs.ts                      # same prompt, two branches, Markdown
npx tsx scripts/probe-message.ts [claude|codex|both]       # break into a live turn, for real
npx tsx scripts/probe-vs-live.ts                           # a whole VS run against both CLIs
script -q /dev/null npx tsx scripts/probe-suspend.tsx      # Ink hands over a real tty
npx tsx scripts/probe-ui.tsx [debate|picker|gist|wrap|focus|takeover]   # one TUI frame
npx tsx scripts/probe-vs-ui.tsx [running|message|done|narrow]           # one VS frame
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

`probe-message` is the one that matters for mid-exchange messages: it gives a
real CLI a long task, breaks in three seconds later with an instruction it would
never volunteer, and fails unless the word comes back — so it can tell the
difference between a message that was delivered and one that was merely sent.
It also measures the gap between one leg's reply and the first sign of the next,
which is where the adapter's quiet deadline comes from, and fails if a real
restart ever creeps close to it.

`probe-vs-live` covers both halves inside a whole VS run: a message added to a
slot mid-exchange, and one sent to a slot that is idle. Each checks that the
change landed on that slot's branch and that the other slot never saw it.

`probe-ui` and `probe-vs-ui` drive the real `App` and `VsApp` against stub
agents through a fake stdin, so layout, wrapping, the pickers, the scoreboard
band and the per-slot message composer can be checked without a TTY or a model
call. `probe-vs-ui done` builds a real repository and worktrees, because the
finished frame reports commits and diffs.
Ink pulls input with `read()` after a `readable` event and swallows the first
200ms while probing for the kitty keyboard protocol, which is why that stub is a
small queue rather than a bare `EventEmitter`.

## Limits

- co-code runs exactly two agents; vs runs up to nine. Either mode can put any
  of the four CLIs in any slot, including the same one in several at once.
- The nine is the keyboard, not the machine: each agent gets a tmux window and a
  single-digit key to reach it, and there is no unambiguous tenth.
- kilo has no reasoning-effort dial — it chooses per model — so doet never asks
  it for one.
- cline's `-s` replaces its system prompt rather than adding to it, and kilo has
  no such flag at all, so for those two doet's standing brief rides in front of
  the first request instead of being a launch flag.
- Codex and cline cannot copy a session, so `w` will not open a worktree for
  them: resuming the session an agent is still working in means two writers on
  one conversation. doet says so rather than doing it.
- cline is the one agent whose turn boundary doet infers rather than reads. If
  its message file parses, the journal is authoritative; if it does not, a still
  session and a still screen end the turn, and tokens show as `–` rather than
  being invented.
- A pane is a view, not a terminal. `enter`/`ctrl+o` hands this terminal to the
  real CLI and re-attaches when it exits.
- Taking a session over interrupts that slot's current turn, releases the
  protocol owner, and re-attaches the same session when you exit its CLI.
- In co-code both agents share one working directory and can edit the same
  files. VS mode is the isolated alternative: one worktree and branch per slot.
- `--resume` reopens agent sessions, not doet's own screen: the panes come back
  empty, with the gist restored and the transcript on disk. Both agents still
  remember everything.
- A `full` handoff sends the whole session as one message. On a long co-code run
  that is a large prompt, and doet does not check it against the model's
  context window first.
- Cost is reported only where the CLI reports it (Claude Code) or where you have
  set a rate (`pricing` in `~/.doet/config.json`). doet ships no price list.
- A message to one slot reaches the agent as a turn, so it costs a turn's worth
  of context. It cannot un-do work already done — it redirects what happens next.
- `m` on a slot that is still finishing up — committing and diffing after its
  reply — is refused rather than queued, since sending then would race that.
  It is a second or two; try again.
- In co-code, typing while an exchange runs queues a note for the *next agent in
  the relay* to receive. That is a different mechanism from `m`, which addresses
  one VS slot and sends immediately.
