import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface Launcher {
  /** Stable id, saved to config once the user picks one. */
  id: string;
  /** Shown in the picker, e.g. "a new tmux window". */
  label: string;
  /** Why you might want it — the picker shows this under the label. */
  description?: string;
  /**
   * True when the new terminal stays where doet already is — a tmux window in
   * the editor panel, say — rather than opening a separate GUI window. Being
   * thrown out of your editor is rarely what you meant, so this decides what
   * gets offered first.
   */
  staysPut: boolean;
  launch(command: string, args: string[], cwd: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shell plumbing
// ---------------------------------------------------------------------------

/** Characters a POSIX shell passes through untouched. */
const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote a token only when the shell would otherwise mangle it.
 *
 * This command gets shown to you and pasted by hand, so quoting every token
 * "just in case" is noise: `'codex' 'resume' 'abc-123'` reads worse than
 * `codex resume abc-123` and is no safer. A path with a space still gets
 * quoted, because there it does something.
 */
function shellQuote(value: string): string {
  if (value.length > 0 && SAFE_TOKEN.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function shellCommand(command: string, args: string[], cwd: string): string {
  return `cd ${shellQuote(cwd)} && ${[command, ...args].map(shellQuote).join(' ')}`;
}

/** AppleScript string literal, which escapes with backslashes rather than quotes. */
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
    );
    child.unref();
  });
}

function has(bin: string): boolean {
  return (process.env.PATH ?? '').split(':').some((dir) => {
    try {
      return dir.length > 0 && existsSync(join(dir, bin));
    } catch {
      return false;
    }
  });
}

/** True when doet is running inside an editor's integrated terminal. */
export function inEditorTerminal(): boolean {
  const term = process.env.TERM_PROGRAM;
  return term === 'vscode' || term === 'Cursor' || term === 'windsurf';
}

// ---------------------------------------------------------------------------
// Launchers
// ---------------------------------------------------------------------------

const tmux: Launcher = {
  id: 'tmux',
  label: 'a new tmux window',
  description:
    'Stays inside this terminal, editor panel included. Needs doet to be running under tmux.',
  staysPut: true,
  // tmux takes argv directly, so nothing has to survive a shell.
  launch: (command, args, cwd) => run('tmux', ['new-window', '-c', cwd, '--', command, ...args]),
};

function macLauncher(app: 'Terminal' | 'iTerm'): Launcher {
  return {
    id: app.toLowerCase(),
    label: `a new ${app} window`,
    description: inEditorTerminal()
      ? 'A separate macOS window — this one takes you out of your editor.'
      : 'A separate macOS window.',
    staysPut: false,
    launch: async (command, args, cwd) => {
      const line = appleScriptString(shellCommand(command, args, cwd));
      const script =
        app === 'Terminal'
          ? `tell application "Terminal"
               activate
               do script ${line}
             end tell`
          : `tell application "iTerm"
               activate
               set w to (create window with default profile)
               tell w's current session to write text ${line}
             end tell`;
      await run('osascript', ['-e', script]);
    },
  };
}

const wezterm: Launcher = {
  id: 'wezterm',
  label: 'a new WezTerm window',
  staysPut: false,
  launch: (command, args, cwd) =>
    run('wezterm', ['cli', 'spawn', '--new-window', '--cwd', cwd, '--', command, ...args]),
};

const kitty: Launcher = {
  id: 'kitty',
  label: 'a new kitty window',
  staysPut: false,
  launch: (command, args, cwd) =>
    run('kitty', [
      '@',
      '--to',
      process.env.KITTY_LISTEN_ON!,
      'launch',
      '--type=os-window',
      '--cwd',
      cwd,
      command,
      ...args,
    ]),
};

/** A user-supplied command, with `{cmd}` and `{cwd}` substituted. */
export function customLauncher(template: string): Launcher {
  return {
    id: 'command',
    label: 'the command you configured',
    description: template,
    // Chosen deliberately, so assume it goes where it was meant to.
    staysPut: true,
    launch: (command, args, cwd) =>
      run('/bin/sh', [
        '-c',
        template
          .replaceAll('{cmd}', [command, ...args].map(shellQuote).join(' '))
          .replaceAll('{cwd}', shellQuote(cwd)),
      ]),
  };
}

/**
 * Every launcher that would actually work here, best first.
 *
 * "Best" means staying where you already are. tmux leads when present because
 * it is the only one that works inside an editor's integrated terminal — no
 * editor lets a child process open a new integrated terminal, so doet cannot
 * put a window there on its own.
 */
export function availableLaunchers(): Launcher[] {
  const found: Launcher[] = [];

  if (process.env.TMUX) found.push(tmux);
  if (has('wezterm')) found.push(wezterm);
  if (has('kitty') && process.env.KITTY_LISTEN_ON) found.push(kitty);

  if (process.platform === 'darwin') {
    found.push(macLauncher(process.env.TERM_PROGRAM === 'iTerm.app' ? 'iTerm' : 'Terminal'));
  }

  return found;
}

export function launcherById(id: string, command?: string): Launcher | null {
  if (id === 'command') return command ? customLauncher(command) : null;
  return availableLaunchers().find((l) => l.id === id) ?? null;
}

/** The one doet would suggest, or null when nothing here can open a window. */
export function detectLauncher(): Launcher | null {
  const template = process.env.DOET_TERMINAL;
  if (template?.trim()) return customLauncher(template);
  return availableLaunchers()[0] ?? null;
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/**
 * Puts the branch command on the clipboard.
 *
 * The fallback that always works: no editor lets a child process open a new
 * integrated terminal, but every editor lets *you* open one and paste. Returns
 * false when there is no clipboard tool, in which case the caller shows the
 * command instead — it is printed into the pane either way.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  const tools: Array<[string, string[]]> =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : [
          ['wl-copy', []],
          ['xclip', ['-selection', 'clipboard']],
          ['xsel', ['--clipboard', '--input']],
        ];

  for (const [bin, args] of tools) {
    if (process.platform !== 'darwin' && !has(bin)) continue;
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(String(code)))));
        child.stdin.end(text);
      });
      return true;
    } catch {
      // Try the next one.
    }
  }
  return false;
}
