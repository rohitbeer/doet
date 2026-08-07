/**
 * Renders the TUI against stub agents and prints frames, so layout, wrapping,
 * the pickers and the permission prompt can be checked without a TTY or a live
 * model call.
 *
 *   npx tsx scripts/probe-ui.tsx           the debate view
 *   npx tsx scripts/probe-ui.tsx picker    the model picker
 *   npx tsx scripts/probe-ui.tsx gist      the gist band
 *   npx tsx scripts/probe-ui.tsx wrap      long unbroken output, to check wrapping
 *   npx tsx scripts/probe-ui.tsx focus     a selected pane, ready to hand over
 *   npx tsx scripts/probe-ui.tsx takeover  double ctrl+o — must not crash
 *   npx tsx scripts/probe-ui.tsx where     the one-time 'where do branches open' setup
 *   npx tsx scripts/probe-ui.tsx summary   the per-session note-taker question
 */
import React from 'react';
import { render } from 'ink';
import { EventEmitter } from 'node:events';
import { Bus } from '../src/core/bus.js';
import { Conductor } from '../src/core/conductor.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { Summarizer } from '../src/core/summarizer.js';
import type { SessionStore } from '../src/core/sessions.js';
import { App } from '../src/ui/App.js';
import type { AgentAdapter, AgentId, AgentInfo, ModelChoice } from '../src/core/types.js';

const scene = process.argv[2] ?? 'debate';

const CLAUDE_MODELS: ModelChoice[] = [
  { id: 'default', label: 'Default (recommended)', description: 'Opus 5 with 1M context · Best for everyday, complex tasks', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'opus[1m]', label: 'Opus (1M context)', description: 'Opus 5 with 1M context', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'sonnet', label: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks', efforts: ['low', 'medium', 'high'] },
  { id: 'haiku', label: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
];

function stub(id: AgentId, model: string): AgentAdapter {
  const info: AgentInfo = {
    id,
    label: id === 'claude' ? 'Claude Code' : 'Codex',
    model,
    effort: id === 'claude' ? 'high' : 'low',
    status: 'ready',
    cwd: process.cwd(),
    permissionMode: id === 'claude' ? 'default' : 'untrusted/workspace-write',
    sessionSeq: 1,
    sessionTurns: 2,
    usage: { outputTokens: id === 'claude' ? 3818 : 1829 },
  };
  return {
    id,
    label: info.label,
    start: async () => {},
    send: async () => ({ agent: id, text: '', verdict: null, usage: {}, interrupted: false }),
    interrupt: async () => {},
    resolvePermission: (reqId, optId) => console.error(`[stub ${id}] resolved ${reqId} -> ${optId}`),
    setModel: async () => {},
    listModels: async () => CLAUDE_MODELS,
    setPermissionMode: async () => {},
    listPermissionModes: () => [],
    newSession: async () => {},
    // Slow on purpose: the crash this guards against lived in the window
    // between pressing ctrl+o and the terminal actually being suspended.
    releaseSession: async () => {
      await new Promise((r) => setTimeout(r, 150));
      return 'stub-session-id';
    },
    resumeSession: async () => {},
    // Harmless stand-ins for the real CLIs, so the probe opens nothing.
    interactiveCommand: () => ({ command: 'sh', args: ['-c', `echo stub-${id}-cli`] }),
    forkSession: async () => ({ command: 'sh', args: ['-c', `echo stub-${id}-fork`] }),
    history: () => '',
    info: () => info,
    dispose: async () => {},
  };
}

const bus = new Bus();
const agents: Record<AgentId, AgentAdapter> = {
  claude: stub('claude', 'sonnet'),
  codex: stub('codex', 'gpt-5.6-sol'),
};

const store = {
  dir: '/tmp/doet',
  finalize: () => '/tmp/doet/session.md',
  snapshot: () => {},
  detach: () => {},
  openQuestion: () => {},
  appendTurn: () => {},
  appendNote: () => {},
  writeGist: () => {},
  writeAgentHistory: () => {},
  writeMeta: () => {},
  noteResumed: () => {},
  readSession: () => '',
  readGist: () => '',
} as unknown as SessionStore;

const summarizer = new Summarizer({ bus, cwd: process.cwd(), setting: DEFAULT_CONFIG.summary });
const conductor = new Conductor({
  bus,
  agents,
  store,
  summarizer,
  sessions: DEFAULT_CONFIG.sessions,
});

// A non-TTY stdout that captures frames instead of drawing them.
const frames: string[] = [];
const fake = new EventEmitter() as unknown as NodeJS.WriteStream;
Object.assign(fake, {
  columns: 120,
  rows: 34,
  write: (chunk: string) => {
    frames.push(chunk);
    return true;
  },
  isTTY: false,
});

/**
 * Ink needs a raw-mode-capable stdin, and it pulls input with `read()` after a
 * `readable` event rather than listening for `data`. So this is a real little
 * readable queue, not just an EventEmitter with the methods stubbed out.
 */
const pending: string[] = [];
const fakeStdin = new EventEmitter() as unknown as NodeJS.ReadStream;
Object.assign(fakeStdin, {
  isTTY: true,
  setRawMode: () => fakeStdin,
  resume: () => fakeStdin,
  pause: () => fakeStdin,
  setEncoding: () => fakeStdin,
  read: () => (pending.length > 0 ? pending.shift()! : null),
  // Ink buffers the first 200ms of stdin while probing for the kitty keyboard
  // protocol, then replays whatever was not a protocol response through this.
  unshift: (data: Uint8Array) => {
    pending.unshift(Buffer.from(data).toString('utf8'));
    fakeStdin.emit('readable');
  },
  unref: () => fakeStdin,
  ref: () => fakeStdin,
});

const app = render(
  <App
    bus={bus}
    conductor={conductor}
    agents={agents}
    store={store}
    summarizer={summarizer}
    config={DEFAULT_CONFIG}
    promptForSummary={scene === 'summary'}
  />,
  { stdout: fake, stdin: fakeStdin, patchConsole: false, exitOnCtrlC: false },
);

/**
 * Ink reads stdin as raw bytes, so keys are fed as escape sequences. Delayed
 * past Ink's 200ms kitty-protocol probe, which otherwise eats the keystrokes.
 */
const type = (text: string, at = 400) =>
  setTimeout(() => {
    pending.push(text);
    fakeStdin.emit('readable');
  }, at);

const LONG =
  'The relay carries only the latest message because each adapter holds a persistent session, ' +
  'which means re-sending the whole transcript every round would burn tokens and invite the ' +
  'models to repeat themselves verbatim instead of engaging with what actually changed.';

setTimeout(() => {
  bus.emit({ kind: 'relay', from: 'user', to: 'claude', round: 0, note: 'opening query' });
  bus.emit({
    kind: 'prompt',
    agent: 'claude',
    label: 'opening',
    text: 'You are Claude Code, taking part in a two-agent working session run by `doet`.\nYour counterpart is Codex. A human is watching both of you.',
  });

  if (scene === 'wrap') {
    bus.emit({ kind: 'text', agent: 'claude', delta: LONG });
    bus.emit({
      kind: 'text',
      agent: 'codex',
      delta: `/Users/someone/a/very/deep/path/that/will/not/fit/in/a/narrow/pane/at/all/file.ts\n${LONG}`,
    });
  } else {
    bus.emit({
      kind: 'text',
      agent: 'claude',
      // Ends with doet's control marker, which the pane must not show: the
      // panes render raw token deltas, not the cleaned message.
      delta:
        '## Short version\n**Relay** only the latest message when each agent keeps a `persistent` session.\n<<<DOET:VERDICT REVISE>>>',
    });
    bus.emit({ kind: 'tool', agent: 'claude', id: 't1', name: 'Bash', summary: 'npm run typecheck', phase: 'start' });
    bus.emit({ kind: 'relay', from: 'claude', to: 'codex', round: 1, note: 'revise' });
    bus.emit({ kind: 'thinking', agent: 'codex', delta: 'Checking the cited files…' });
    bus.emit({
      kind: 'text',
      agent: 'codex',
      delta: 'Claude’s core claim is correct, but it\nexceeds the 120-word limit.',
    });
  }

  if (scene === 'gist') {
    // A long notice too: this is what used to overflow the header and garble it.
    bus.emit({
      kind: 'log',
      source: 'doet',
      message: 'saved · 2026-08-07T09-58-30-e67aa49d',
    });
    bus.emit({
      kind: 'gist',
      round: 1,
      text:
        '**Goal** — Decide whether the relay should carry the full transcript each round.\n\n' +
        '**Settled** — Both adapters hold a persistent session, so each agent already remembers its own turns. `npm run typecheck` passes clean.\n\n' +
        '**Open** — Whether the gist should be injected on first contact or only from round two.\n\n' +
        '**Next** — Codex re-reads src/core/relay.ts and checks the token cost.',
    });
  }

  // Enter goes in its own read: Ink treats a multi-character chunk as a paste,
  // so a carriage return in the same chunk never registers as a return key.
  if (scene === 'picker') {
    type('/model claude', 400);
    type('\r', 500);
  }

  // Right arrow selects the Codex pane, then ctrl+o asks to take it over. The
  // conductor is idle here, so this shows the focused-pane chrome rather than
  // the mid-turn confirmation.
// Two ctrl+o presses ~60ms apart, inside the window where releaseSession is
  // still running. The second must be refused, not crash the process.
  if (scene === 'takeover') {
    type('\u000f', 400);
    type('\u000f', 460);
  }

  // The one-time setup question, as an editor terminal would show it.
  if (scene === 'where') {
    type('/where', 400);
    type('\r', 500);
  }

  if (scene === 'focus') {
    type('\u001b[C', 400); // right arrow selects the Codex pane
  }

  if (scene === 'debate') {
    bus.emit({
      kind: 'permission',
      agent: 'codex',
      request: {
        id: 'p1',
        agent: 'codex',
        kind: 'exec',
        title: 'Shell command',
        summary: "/bin/zsh -lc 'npm run typecheck'",
        detail: "/bin/zsh -lc 'npm run typecheck'",
        reason: 'Verifying the claim that the project typechecks cleanly.',
        cwd: process.cwd(),
        options: [
          { id: 'd:accept', label: 'Allow once', key: 'a', tone: 'allow' },
          { id: 's:acceptForSession:exec', label: 'Allow for session', key: 's', tone: 'allow' },
          { id: 'd:decline', label: 'Deny', key: 'd', tone: 'deny' },
        ],
        createdAt: Date.now(),
      },
    });
  }
}, 60);

setTimeout(() => {
  app.unmount();
  const last = frames.filter((f) => f.includes('doet')).pop() ?? frames[frames.length - 1] ?? '';
  process.stdout.write(`${last}\n`);
  process.stdout.write(`\n[scene=${scene}, captured ${frames.length} frames]\n`);
  process.exit(0);
}, 900);
