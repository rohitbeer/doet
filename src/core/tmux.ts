import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The tmux doet needs, and nothing more.
 *
 * doet used to draw the agents itself: it drove each CLI over a protocol and
 * re-rendered the result into an Ink pane. That worked, but the pane was always
 * a worse copy of a UI the CLI already had — tool results arrived as two
 * thousand characters of raw text where the real thing shows one collapsed
 * line, fenced code lost its formatting, and every wrapping and scrollback bug
 * was doet's to write and then to fix.
 *
 * So the agents are not redrawn any more. Each one runs as its real terminal
 * program in a real tmux pane, exactly as if you had started it yourself, and
 * doet arranges the panes and talks to them. What doet needs to *know* — when a
 * turn ended, what was said, what it cost — comes from the transcripts the CLIs
 * already write to disk (see `journal.ts`), not from reading the screen.
 *
 * Everything here shells out to `tmux`. There is a control-mode protocol that
 * would avoid re-spawning a client per call, but every command below is a
 * one-shot against a running server, they are not on any hot path, and a
 * long-lived control connection is a second thing that can wedge.
 */

/** Never let a stuck tmux command hang a session the way a stuck agent would. */
const TMUX_TIMEOUT_MS = 10_000;

/**
 * Session-scoped display options, written once as the server's config and set
 * again afterwards.
 *
 * Titled borders are the one that earns its place: with two agents side by
 * side, which pane is which is the question you ask most, and a border label
 * answers it without spending a row on a header the way doet's own panes did.
 */
const OPTIONS: Array<[scope: '-g' | '-s', option: string, value: string]> = [
  // Server-level, and the outermost safety net: without it a server whose last
  // session has gone exits immediately, taking with it the one thing doet could
  // still have asked — what happened. With it, a collapsed layout leaves a
  // server standing that can at least say the session is gone.
  ['-s', 'exit-empty', 'off'],
  // A pane that exits stays visible with its output, rather than vanishing and
  // reflowing the layout out from under whatever you were reading — and, first
  // of all, rather than taking the server down with it. See `create`.
  ['-g', 'remain-on-exit', 'on'],
  ['-g', 'pane-border-status', 'top'],
  // `@doet_label`, not `#{pane_title}`. Both agent CLIs set their own pane
  // title — Claude to "✳ Claude Code", Codex to the directory basename — so a
  // border built from the title shows whatever they last decided and loses the
  // one thing the border is for: which pane is slot A. A custom user option is
  // doet's alone and nothing else writes it.
  ['-g', 'pane-border-format', ' #{?@doet_label,#{@doet_label},#{pane_title}} '],
  ['-g', 'mouse', 'on'],
  // Keeps window numbers contiguous when one is closed, so "the second agent"
  // and "window 2" do not drift apart over a long session. Only the modern
  // layout uses more than one window at all.
  ['-g', 'renumber-windows', 'on'],
  // Long scrollback: the transcript is the point, and these panes are the only
  // place the agent's own rendering of it exists.
  ['-g', 'history-limit', '50000'],
  ['-g', 'status', 'off'],
];

/**
 * One option value, safe to write as a word in a tmux config file.
 *
 * Only the config file needs this. Every other call in this file hands tmux an
 * argv array, where a value with spaces in it is just a string.
 */
function quoteForConfig(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface TmuxResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Runs tmux and *returns* the failure rather than throwing it.
 *
 * Same reasoning as `git()`: half of these are questions whose answer is "no" —
 * is the server up, is that pane still alive — and a rejected promise is the
 * wrong shape for a question.
 */
export async function tmux(
  socket: string,
  args: string[],
  opts: { config?: string } = {},
): Promise<TmuxResult> {
  try {
    const flags = opts.config ? ['-f', opts.config] : [];
    const { stdout, stderr } = await run('tmux', ['-L', socket, ...flags, ...args], {
      timeout: TMUX_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.replace(/\n$/, ''), stderr: stderr.trim() };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: (e.stdout ?? '').replace(/\n$/, ''),
      stderr: (e.stderr ?? e.message ?? '').trim(),
    };
  }
}

/** True when a usable tmux is on PATH. Checked before doet offers to run at all. */
export async function tmuxAvailable(): Promise<{ ok: boolean; version?: string }> {
  try {
    const { stdout } = await run('tmux', ['-V'], { timeout: TMUX_TIMEOUT_MS });
    return { ok: true, version: stdout.trim() };
  } catch {
    return { ok: false };
  }
}

export interface PaneInfo {
  /** tmux's own `%n` id. Stable for the life of the pane, unlike an index. */
  id: string;
  pid: number;
  command: string;
  width: number;
  height: number;
  dead: boolean;
}

export interface PaneSpec {
  /** Shown in the pane's border, so you can tell the two apart at a glance. */
  title: string;
  cwd: string;
  command: string;
  args: string[];
  /**
   * Short name for the window, when this pane gets one to itself. Kept apart
   * from `title` because the border has room for `Claude Code · sonnet · high`
   * and a window name does not.
   */
  name?: string;
}

/**
 * One tmux session, on a socket of doet's own.
 *
 * `-L doet-<id>` rather than the user's default server, for two reasons: a
 * crash cannot leave debris in the session they were already working in, and
 * doet can set session-scoped options — pane borders, mouse mode, status line —
 * without touching a `.tmux.conf` that is none of its business.
 */
export class TmuxSession {
  readonly socket: string;
  readonly name: string;

  private constructor(socket: string, name: string) {
    this.socket = socket;
    this.name = name;
  }

  /**
   * Starts a detached session holding one pane.
   *
   * Detached on purpose: doet builds the whole layout before anything is shown,
   * so the user never watches panes appear one at a time. `attachCommand()` is
   * what puts it on screen.
   */
  static async create(opts: {
    id: string;
    first: PaneSpec;
    width: number;
    height: number;
  }): Promise<{ session: TmuxSession; pane: string }> {
    const socket = `doet-${opts.id}`;
    const name = 'doet';

    // The options are handed to the server as a config file rather than set
    // afterwards, and that ordering is the whole point of this dance.
    //
    // `remain-on-exit` only holds a pane open if it is already in force when the
    // pane's command dies. Setting it after `new-session` is a race doet loses
    // exactly when it can least afford to: if the first pane — doet's own —
    // fails immediately, it exits before the option lands, its window goes with
    // it, the last session goes with that, and the server exits. The user, who
    // by then is attaching, sees "[server exited unexpectedly]" and not one word
    // of whatever the pane was trying to say. A config file is read while the
    // server starts, which is before any command in it runs.
    const config = mkdtempSync(join(tmpdir(), 'doet-tmux-'));
    const configPath = join(config, 'tmux.conf');
    // Values are quoted, and that is not tidiness.
    //
    // Everywhere else in doet a tmux option travels as an argv entry, where
    // whitespace is simply part of the string. In a config file it is not: this
    // is a line of tmux's own config language, and `pane-border-format`'s value
    // both begins and ends with a space — deliberately, since that is the
    // padding either side of the border label. Written bare, the trailing one
    // reads as an empty extra argument, and the consequences are out of all
    // proportion to the cause:
    //
    //   tmux.conf:5: empty value
    //
    // tmux stops reading the file there. Every option below the offending line
    // is silently skipped — mouse, renumber-windows, history-limit, status —
    // and the first client to attach is shown that message as a modal it will
    // not dismiss until you press a key. In the interactive layout that lands
    // in doet's narrow middle pane and reads as a stray warning. In the modern
    // one doet's pane is the whole terminal, so a run that is in fact perfectly
    // healthy comes up as one line of error on an empty screen.
    //
    // The line number is a red herring too: tmux reports the failure against
    // the line *after* the one that caused it.
    writeFileSync(
      configPath,
      `${OPTIONS.map(([scope, option, value]) => `set-option ${scope} ${option} ${quoteForConfig(value)}`).join('\n')}\n`,
      'utf8',
    );

    try {
      const created = await tmux(
        socket,
        [
          'new-session',
          '-d',
          '-s',
          name,
          // Named, or tmux calls this window after whatever command is in it —
          // "node". Invisible in the interactive layout, but the modern one
          // makes windows something you navigate between by name.
          '-n',
          'doet',
          '-x',
          String(Math.max(20, opts.width)),
          '-y',
          String(Math.max(10, opts.height)),
          '-c',
          opts.first.cwd,
          '-P',
          '-F',
          '#{pane_id}',
          opts.first.command,
          ...opts.first.args,
        ],
        { config: configPath },
      );
      if (!created.ok) {
        throw new Error(`could not start a tmux session: ${created.stderr || created.stdout}`);
      }

      const session = new TmuxSession(socket, name);
      const pane = created.stdout.trim();
      // Again, in case this server was already up and did not read the file.
      await session.configure();
      await session.setTitle(pane, opts.first.title);
      return { session, pane };
    } finally {
      rmSync(config, { recursive: true, force: true });
    }
  }

  /**
   * Adopts a session that already exists.
   *
   * doet launches in your terminal but has to *run* inside the layout it
   * builds, so it creates the session with itself as the first pane and then
   * attaches. The copy of doet in that pane needs the same session this one
   * made, not a new one — it takes the socket by name and carries on.
   */
  static open(socket: string, name = 'doet'): TmuxSession {
    return new TmuxSession(socket, name);
  }

  /** Applies `OPTIONS` to a server that is already up. */
  private async configure(): Promise<void> {
    for (const [scope, option, value] of OPTIONS) {
      await tmux(this.socket, ['set-option', scope, option, value]);
    }
  }

  /**
   * Adds a pane beside an existing one and returns its id.
   *
   * `-d` keeps focus where it was, so building a layout does not walk the
   * cursor across the screen.
   */
  async split(
    from: string,
    spec: PaneSpec,
    opts: { direction?: 'horizontal' | 'vertical'; before?: boolean } = {},
  ): Promise<string> {
    const result = await tmux(this.socket, [
      'split-window',
      opts.direction === 'vertical' ? '-v' : '-h',
      // `-b` puts the new pane *before* the one it split from, which is what
      // lets doet sit between the two agents rather than off to one side.
      ...(opts.before ? ['-b'] : []),
      '-d',
      '-t',
      from,
      '-c',
      spec.cwd,
      '-P',
      '-F',
      '#{pane_id}',
      spec.command,
      ...spec.args,
    ]);
    if (!result.ok) {
      throw new Error(`could not add a tmux pane: ${result.stderr || result.stdout}`);
    }
    const pane = result.stdout.trim();
    await this.setTitle(pane, spec.title);
    return pane;
  }

  /**
   * Puts a pane in a window of its own, off to one side.
   *
   * This is what the modern UI is built on. A pane in a background window is
   * not a diminished pane: tmux sizes every window to the attached client, so
   * an agent filed away here is running at the full width of your terminal and
   * has been all along — which is the whole reason this is a window rather than
   * an unzoomed pane. Zooming doet's own pane would have left the agents
   * rendering at a third of the width, and every line they had written while
   * hidden would still be wrapped to it when you finally looked.
   *
   * Everything else about the pane is unchanged: pastes land in it, captures
   * read it, and the transcript it writes is the same file. Being out of sight
   * is a fact about your screen, not about the agent.
   */
  async newWindow(spec: PaneSpec): Promise<{ pane: string; window: number }> {
    const result = await tmux(this.socket, [
      'new-window',
      // Built, not switched to. doet is mid-startup and still assembling the
      // layout; walking the user through each window as it appears is the thing
      // `-d` exists to avoid.
      '-d',
      // No `-t`, and that is deliberate rather than an omission.
      //
      // `new-window`'s target is a *window*, not a session, so `-t doet` only
      // ever worked here by accident: it fell through to the session because no
      // window happened to be called that. Naming doet's own window `doet` made
      // it resolve to window 0 instead, and every agent died at startup with
      // "index 0 in use". Spelling it `-a -t doet:0` fixes the ambiguity but
      // inserts *after* window 0, which reverses the agents on the second call.
      //
      // Without a target, tmux uses the current session and takes the next free
      // index — appending in creation order, which is the order doet wants.
      // Unambiguous because a doet socket holds exactly one session; see the
      // `-L doet-<id>` reasoning on this class.
      '-n',
      spec.name ?? spec.title,
      '-c',
      spec.cwd,
      '-P',
      '-F',
      '#{pane_id}\t#{window_index}',
      spec.command,
      ...spec.args,
    ]);
    if (!result.ok) {
      throw new Error(`could not add a tmux window: ${result.stderr || result.stdout}`);
    }
    // The index is read back rather than assumed. doet creates these in order
    // and would usually be right to count 1, 2 — but "usually" is doing real
    // work in that sentence, and a wrong index means a navigation key that
    // takes you to the wrong agent.
    const [pane = '', index = ''] = result.stdout.trim().split('\t');
    if (!pane) throw new Error('tmux created a window but did not say which pane.');
    await this.setTitle(pane, spec.title);
    return { pane, window: Number(index) || 0 };
  }

  /**
   * Which window a pane is currently in, or undefined if it has gone.
   *
   * Asked rather than remembered, because a pane can be moved out from under
   * the number doet wrote down: `renumber-windows` closes the gap when a window
   * is killed, so an agent restarted in a new working tree — VS plugging a slot
   * into main — ends up at an index nobody predicted.
   */
  async windowOf(pane: string): Promise<number | undefined> {
    const result = await tmux(this.socket, [
      'list-panes',
      '-a',
      '-F',
      '#{pane_id}\t#{window_index}',
    ]);
    if (!result.ok) return undefined;
    for (const line of result.stdout.split('\n')) {
      const [id = '', index = ''] = line.split('\t');
      if (id === pane) return Number(index) || 0;
    }
    return undefined;
  }

  async selectWindow(window: number): Promise<void> {
    await tmux(this.socket, ['select-window', '-t', `${this.name}:${window}`]);
  }

  /**
   * Keys that move between windows without a prefix.
   *
   * Bound in the root table, which means they are read before the program in
   * the pane sees them — and that is the point. Once you are looking at Claude,
   * your keystrokes are Claude's; doet is not being typed at any more and
   * cannot offer you a way back. Only tmux is still listening, so the way back
   * has to be tmux's.
   *
   * Root bindings are taken from the agent CLIs permanently, so these are
   * chosen to be keys neither one wants: Alt-digit and F12. The prefix key
   * still works for everything else.
   */
  async bindNavigation(bindings: Array<{ key: string; window: number }>): Promise<void> {
    for (const { key, window } of bindings) {
      await tmux(this.socket, ['bind-key', '-n', key, 'select-window', '-t', `${this.name}:${window}`]);
    }
  }

  async setTitle(pane: string, title: string): Promise<void> {
    // Both: the user option is what the border renders and cannot be taken
    // away, the title is set too so anything else looking at this pane the
    // ordinary way still sees something sensible until the CLI overwrites it.
    await tmux(this.socket, ['set-option', '-p', '-t', pane, '@doet_label', title]);
    await tmux(this.socket, ['select-pane', '-t', pane, '-T', title]);
  }

  /** Evens the split back out after panes have been added. */
  async tile(direction: 'even-horizontal' | 'even-vertical' = 'even-horizontal'): Promise<void> {
    await tmux(this.socket, ['select-layout', '-t', this.name, direction]);
  }

  /**
   * Every pane in the session, across every window.
   *
   * `-s` is not optional, and the bug it fixes is worth recording. A session
   * target on its own means the session's *current* window, so without this an
   * agent filed away under the modern layout was simply not in the list — and
   * `paneAlive` answered "no" for a CLI that was running perfectly well. Both
   * agents were then reported as having "exited during startup", with an empty
   * screen underneath, because the pane doet could not find was never dead.
   */
  async listPanes(): Promise<PaneInfo[]> {
    const result = await tmux(this.socket, [
      'list-panes',
      '-s',
      '-t',
      this.name,
      '-F',
      '#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_width}\t#{pane_height}\t#{pane_dead}',
    ]);
    if (!result.ok || !result.stdout) return [];

    return result.stdout.split('\n').filter(Boolean).map((line) => {
      const [id = '', pid = '0', command = '', width = '0', height = '0', dead = '0'] =
        line.split('\t');
      return {
        id,
        pid: Number(pid) || 0,
        command,
        width: Number(width) || 0,
        height: Number(height) || 0,
        dead: dead === '1',
      };
    });
  }

  /** Whether the server is still up and still holding this session. */
  async alive(): Promise<boolean> {
    const result = await tmux(this.socket, ['has-session', '-t', this.name]);
    return result.ok;
  }

  async paneAlive(pane: string): Promise<boolean> {
    const panes = await this.listPanes();
    const found = panes.find((candidate) => candidate.id === pane);
    return found !== undefined && !found.dead;
  }

  /**
   * Types text into a pane's own input box, the way a paste does.
   *
   * This is the one primitive the whole design rests on, so it is worth saying
   * exactly why it is a buffer paste and not `send-keys`:
   *
   * `send-keys` takes its argument as a list of key names, so every character
   * that happens to spell one gets interpreted rather than typed, and a literal
   * newline in the middle submits the message early. Relaying one agent's
   * three-thousand-word answer to the other that way mangles it. `load-buffer`
   * moves the text as bytes and `paste-buffer` delivers it in one go.
   *
   * `-p` wraps it in bracketed-paste markers when the program has asked for
   * them, which both CLIs do. That is what makes a multi-line message arrive as
   * one paste sitting in the composer instead of as N separate submissions —
   * measured, not assumed: pasting two lines leaves both in the input box and
   * nothing is sent until `submit` presses Enter.
   */
  async paste(pane: string, text: string, opts: { submit?: boolean } = {}): Promise<void> {
    const buffer = `doet-${pane.replace(/[^a-zA-Z0-9]/g, '')}`;
    const loaded = await this.loadBuffer(buffer, text);
    if (!loaded.ok) {
      throw new Error(`could not stage text for ${pane}: ${loaded.stderr || loaded.stdout}`);
    }
    // `-d` deletes the buffer after pasting, so a long relay is not left
    // sitting in tmux's paste stack for the rest of the session.
    const pasted = await tmux(this.socket, ['paste-buffer', '-p', '-d', '-b', buffer, '-t', pane]);
    if (!pasted.ok) {
      throw new Error(`could not paste into ${pane}: ${pasted.stderr || pasted.stdout}`);
    }
    if (opts.submit) await this.submit(pane);
  }

  /**
   * Enter, on its own, after a paste has settled.
   *
   * Separated from the paste by a beat because the CLIs re-render their
   * composer when a paste lands, and an Enter that arrives inside that redraw
   * is sometimes swallowed. This is the cheapest reliable fix; the alternative
   * is polling the rendered screen for the pasted text, which is the screen
   * scraping this design exists to avoid.
   */
  async submit(pane: string): Promise<void> {
    await delay(250);
    await tmux(this.socket, ['send-keys', '-t', pane, 'Enter']);
  }

  /** Named keys — `Escape`, `C-c` — where the interpretation is the point. */
  async keys(pane: string, ...keys: string[]): Promise<void> {
    await tmux(this.socket, ['send-keys', '-t', pane, ...keys]);
  }

  private async loadBuffer(buffer: string, text: string): Promise<TmuxResult> {
    // Through stdin rather than a temp file: a relayed message is the user's
    // and the agent's words, and writing it to /tmp to move it two inches is
    // both a leak and a thing to clean up.
    try {
      const child = run('tmux', ['-L', this.socket, 'load-buffer', '-b', buffer, '-'], {
        timeout: TMUX_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      });
      child.child.stdin?.end(text);
      const { stdout, stderr } = await child;
      return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message?: string };
      return {
        ok: false,
        stdout: (e.stdout ?? '').trim(),
        stderr: (e.stderr ?? e.message ?? '').trim(),
      };
    }
  }

  /**
   * The rendered contents of a pane.
   *
   * Deliberately not used to work out what an agent is doing — that comes from
   * the journal. This is for showing the user what is on a pane they cannot
   * currently see, and for reporting why a CLI died in its own words.
   */
  async capture(pane: string, lines = 200): Promise<string> {
    const result = await tmux(this.socket, [
      'capture-pane',
      '-p',
      '-t',
      pane,
      '-S',
      `-${Math.max(0, lines)}`,
    ]);
    return result.ok ? result.stdout : '';
  }

  /**
   * Only what is on screen right now, with no scrollback.
   *
   * The distinction matters more than it looks. `capture` reaches back into
   * history, so anything that has ever been displayed keeps showing up in the
   * text — which turns "is a dialog open?" into "has a dialog ever been open?".
   * That is a question whose answer never goes back to no: doet answered
   * Codex's trust prompt, the prompt closed, the words stayed in the history,
   * and doet went on answering a dialog that was no longer there until it hit
   * its own retry limit. Anything deciding what the pane is doing *now* has to
   * use this one.
   */
  async captureVisible(pane: string): Promise<string> {
    const result = await tmux(this.socket, ['capture-pane', '-p', '-t', pane]);
    return result.ok ? result.stdout : '';
  }

  async selectPane(pane: string): Promise<void> {
    await tmux(this.socket, ['select-pane', '-t', pane]);
  }

  /**
   * Closes one pane and lets the rest reclaim its space.
   *
   * Used when an agent has to be restarted somewhere else — a slot moving into
   * the main working tree, say — where leaving the old pane up would show a
   * dead session beside the live one.
   */
  async killPane(pane: string): Promise<void> {
    await tmux(this.socket, ['kill-pane', '-t', pane]);
  }

  /** Whether a client is currently looking at this session. */
  async attached(): Promise<boolean> {
    const result = await tmux(this.socket, [
      'display-message',
      '-p',
      '-t',
      this.name,
      '#{session_attached}',
    ]);
    return result.ok && result.stdout.trim() !== '0';
  }

  /**
   * How to put this session on screen.
   *
   * Handed back rather than run, because who attaches depends on where doet is:
   * the controller runs it directly when doet owns the terminal, and prints it
   * for the user when it does not.
   */
  attachCommand(): { command: string; args: string[] } {
    return { command: 'tmux', args: ['-L', this.socket, 'attach-session', '-t', this.name] };
  }

  async kill(): Promise<void> {
    await tmux(this.socket, ['kill-server']);
  }
}

/**
 * Deliberately *not* unref'd.
 *
 * Elsewhere in doet a timer is a deadline raced against real work, and there
 * unref'ing it is right: it must not be the reason the process stays up. This
 * one is the work — the pause between a paste and the Enter that submits it —
 * so an unref'd timer here lets Node decide it has nothing left to do and exit
 * with the paste half-delivered.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
