import { useEffect } from 'react';
import { useStdin, useStdout } from 'ink';

/**
 * Clicking, in a terminal, without any of it reaching the composer.
 *
 * Ink has no mouse support, so this is the whole of it: ask the terminal for
 * mouse reports, read them off stdin ourselves, and give Ink's own input
 * handling a way to recognise and ignore the same bytes.
 *
 * It works under tmux because tmux forwards mouse events to a program that has
 * asked for them, rather than acting on them itself — which is what `mouse on`
 * in `tmux.ts` is for. Measured rather than assumed: an SGR report fed to an Ink
 * app arrives intact at a raw `stdin` listener, and `useInput` sees it as an
 * ordinary input string with `key.escape` false. That last part is the load
 * bearing one. Had a click looked like Escape, every click would have stopped
 * the running turn.
 */

export interface MouseClick {
  /** 0 is the left button; wheel and drag events are filtered out before this. */
  button: number;
  /** 1-based, as the terminal reports it, relative to this pane. */
  col: number;
  row: number;
}

/** Enable mouse reporting, in SGR encoding so coordinates past column 223 survive. */
const ON = '[?1000;1006h';
const OFF = '[?1000;1006l';

/** `ESC [ < button ; col ; row (M|m)` — M is a press, m a release. */
const REPORT = /?\[<(\d+);(\d+);(\d+)([Mm])/g;

/**
 * Whether a chunk of input is the terminal reporting the mouse.
 *
 * `useInput` must call this and bail, or every click types `[<0;12;5M` into
 * whatever has focus. Ink strips the leading escape before handing the string
 * over, so the pattern has to tolerate its absence.
 */
export function isMouseReport(input: string): boolean {
  return /?\[<\d+;\d+;\d+[Mm]/.test(input);
}

export function useMouse(enabled: boolean, onClick: (click: MouseClick) => void): void {
  const { stdout } = useStdout();
  const { stdin, setRawMode, isRawModeSupported } = useStdin();

  useEffect(() => {
    if (!enabled || !isRawModeSupported) return;

    // Ink turns raw mode on for `useInput` already, but this hook cannot assume
    // the component using it also takes keyboard input. Raw mode is
    // reference-counted, so claiming and releasing a turn of our own is safe.
    setRawMode(true);
    stdout.write(ON);

    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      // A single read can carry several reports — a press and its release
      // arrive together often enough — so this walks the chunk rather than
      // matching once.
      REPORT.lastIndex = 0;
      let match = REPORT.exec(text);
      while (match) {
        const [, button = '0', col = '0', row = '0', kind = 'M'] = match;
        // Presses only. Releases would fire every action twice, and tmux sends
        // drag and wheel events through the same channel with flag bits set —
        // 32 for motion, 64 for the wheel — none of which is a click.
        const code = Number(button);
        if (kind === 'M' && (code & 0b1100000) === 0) {
          onClick({ button: code & 0b11, col: Number(col), row: Number(row) });
        }
        match = REPORT.exec(text);
      }
    };

    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
      // Put the terminal back. Left on, it survives doet exiting and the shell
      // you return to starts printing escape codes when you move the mouse.
      stdout.write(OFF);
      setRawMode(false);
    };
  }, [enabled, isRawModeSupported, onClick, setRawMode, stdin, stdout]);
}
