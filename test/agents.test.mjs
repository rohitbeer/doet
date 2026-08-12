import { check, section, report, dist } from './harness.mjs';
// Exercises the DOET-004 pieces that do not need credentials: the argv each
// definition builds, the slot alphabet, and both new journal readers against
// the real (empty) databases the CLIs created on this machine.

const { CLIS, cliFor, AGENT_LABELS, AGENT_COLOR, available } = await import(dist('core/agents/registry.js'));
const { slotIds, MAX_SLOTS } = await import(dist('core/types.js'));
const { framedPrompt } = await import(dist('core/relay.js'));
const { vsInstructions } = await import(dist('core/vs.js'));


section('slot alphabet');
check('slotIds(2)', JSON.stringify(slotIds(2)) === '["a","b"]');
check('slotIds(9)', slotIds(9).length === 9 && slotIds(9)[8] === 'i');
check(`slotIds(${MAX_SLOTS + 1}) throws`, (() => {
  try { slotIds(MAX_SLOTS + 1); return false; } catch { return true; }
})());
check('slotIds(0) throws', (() => {
  try { slotIds(0); return false; } catch { return true; }
})());

section('launch argv, VS posture (accept-edits, worktree, extra root)');
const ctx = {
  cwd: '/tmp/wt-a',
  model: 'M',
  effort: 'high',
  provider: 'anthropic',
  addDirs: ['/repo/.git'],
  instructions: 'BRIEF',
  autonomy: 'accept-edits',
};
for (const id of Object.keys(CLIS)) {
  const def = cliFor(id);
  // The adapter filters unsupported fields before calling launch; mirror it.
  const s = def.supports;
  const argv = def.launch({
    ...ctx,
    ...(s.efforts?.includes(ctx.effort) ? {} : { effort: undefined }),
    ...(s.provider ? {} : { provider: undefined }),
    addDirs: s.addDirs ? ctx.addDirs : [],
    ...(s.systemPrompt === 'append' ? {} : { instructions: undefined }),
  });
  console.log(`  ${def.command} ${argv.join(' ')}`);
}

section('capability invariants');
for (const id of Object.keys(CLIS)) {
  const def = cliFor(id);
  check(`${id}: has a label/colour`, Boolean(AGENT_LABELS[id] && AGENT_COLOR[id]));
  check(`${id}: fork() agrees with supports.fork`,
    (def.fork('sid', '/tmp') === null) === !def.supports.fork);
  const noEffort = def.launch({ ...ctx, effort: undefined, addDirs: [], instructions: undefined });
  check(`${id}: no --effort when none set`, !noEffort.join(' ').includes('effort'));
  // 'ask' must be strictly more restrictive than 'accept-edits'.
  const ask = def.launch({ ...ctx, autonomy: 'ask', addDirs: [], instructions: undefined }).join(' ');
  const acc = def.launch({ ...ctx, autonomy: 'accept-edits', addDirs: [], instructions: undefined }).join(' ');
  check(`${id}: autonomy changes the argv`, ask !== acc, `${ask.slice(0, 60)} vs ${acc.slice(0, 60)}`);
}

section('brief folding for CLIs with no append flag');
const folded = framedPrompt('BRIEF', 'do the thing');
check('brief precedes the request', folded.indexOf('BRIEF') < folded.indexOf('do the thing'));
check('brief is delimited', folded.includes('<session-brief>'));
check('empty brief is a no-op', framedPrompt('', 'x') === 'x');

section('vs brief wording');
check('2 agents reads singular', vsInstructions('a', 2).includes('Another coding agent receives'));
check('5 agents reads plural', vsInstructions('a', 5).includes('4 other coding agents receive'));
check('1 agent says so', vsInstructions('a', 1).includes('only agent'));

section('journal readers against the real stores');
for (const id of ['kilo', 'cline']) {
  const j = cliFor(id).journal;
  const t0 = Date.now();
  const known = await j.known('/tmp/nowhere-doet-probe');
  const found = await j.find('/tmp/nowhere-doet-probe', Date.now(), known);
  const state = await j.read('no-such-session');
  const ms = Date.now() - t0;
  check(`${id}: known() returns a Set`, known instanceof Set);
  check(`${id}: find() is null for an unknown dir`, found === null);
  check(`${id}: read() of a missing session is empty, not a throw`,
    Array.isArray(state.turns) && state.turns.length === 0);
  check(`${id}: three reads under 2s (was ~1.5s per subprocess)`, ms < 2000, `${ms}ms`);
}

section('availability check');
for (const id of Object.keys(CLIS)) {
  const a = await available(id);
  console.log(`  ${id}: ${a.ok ? `ok ${a.version ?? ''}` : a.error}`);
}

report('agent registry');
