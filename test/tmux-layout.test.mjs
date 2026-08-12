import { check, section, report, dist, skip, has } from './harness.mjs';

if (!has("tmux", ['-V'])) skip("tmux is not installed");
// Does the windowed layout actually hold at N > 2? Builds a real tmux session
// with doet's own code — nine agent windows, the navigation keys bound — and
// reads back what tmux thinks it has. No agents: `sleep` stands in, because the
// question is about the layout, not about what runs in it.
const { TmuxSession, tmux } = await import(dist('core/tmux.js'));
const { slotIds } = await import(dist('core/types.js'));

const id = `probe-${process.pid}`;

const { session, pane } = await TmuxSession.create({
  id, width: 200, height: 50,
  first: { title: 'doet', cwd: process.cwd(), command: 'sleep', args: ['30'] },
});

try {
  const order = slotIds(9);
  const windows = [];
  for (const slot of order) {
    const placed = await session.newWindow({
      title: `${slot.toUpperCase()} · agent  —  F12 back to doet`,
      name: `${slot}-agent`,
      cwd: process.cwd(),
      command: 'sleep', args: ['30'],
    });
    windows.push(placed.window);
  }

  check('nine windows, indexes 1..9 in creation order',
    JSON.stringify(windows) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9]), windows);

  const panes = await session.listPanes();
  check('every window is alive and listed', panes.length === 10 && panes.every((p) => !p.dead),
    { count: panes.length, dead: panes.filter((p) => p.dead).length });
  check('doet\'s own pane is alive', await session.paneAlive(pane));

  // The keys the dashboard promises.
  await session.bindNavigation([
    { key: 'F12', window: 0 }, { key: 'M-0', window: 0 },
    ...windows.flatMap((w) => [{ key: `F${w}`, window: w }, { key: `M-${w}`, window: w }]),
  ]);
  const bound = await tmux(session.socket, ['list-keys', '-T', 'root']);
  const keys = bound.stdout;
  check('F1..F9 bound', [1,2,3,4,5,6,7,8,9].every((n) => keys.includes(`F${n} `)));
  check('F12 bound back to doet', keys.includes('F12'));
  check('M-0..M-9 bound', [0,1,2,3,4,5,6,7,8,9].every((n) => keys.includes(`M-${n} `)));

  // Selecting a window has to actually move the session.
  //
  // Read via `window_active` rather than `display-message -t doet`: with no
  // client attached, that target resolves to window 0 regardless of which
  // window is current, so it answers a different question than it appears to.
  await session.selectWindow(7);
  const listed = await tmux(session.socket,
    ['list-windows', '-t', 'doet', '-F', '#{window_index} #{window_active}']);
  const active = listed.stdout.split('\n').find((line) => line.endsWith(' 1'))?.split(' ')[0];
  check('selectWindow(7) moves there', active === '7', listed.stdout);

  // The border label survives the CLI setting its own pane title.
  const labels = await tmux(session.socket, ['list-panes', '-s', '-t', 'doet', '-F', '#{@doet_label}']);
  check('every pane carries its doet label',
    labels.stdout.split('\n').filter(Boolean).length === 10, labels.stdout.split('\n').length);

  // What the dashboard's `w` key does: a tenth window opened later, in a
  // worktree, must not disturb the nine already bound.
  const extra = await session.newWindow({
    title: 'A · worktree', name: 'a-tree', cwd: process.cwd(), command: 'sleep', args: ['30'],
  });
  check('a worktree window appends past the agents', extra.window === 10, extra.window);
  check('the agent windows keep their indexes',
    (await session.windowOf(panes[3].id)) !== undefined);
} finally {
  await session.kill().catch(() => {});
}

report('windowed layout');
