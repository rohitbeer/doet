/**
 * Builds `dist/doet.mjs` — one file with everything in it.
 *
 * This exists so that doet can be *used* on a machine that will never build it.
 * The ordinary `tsc` output in `dist/` needs `ink` and `react` beside it in
 * `node_modules`, which means a clone is not runnable until `npm install` has
 * fetched them; and `npm install` runs `prepare`, which needs `typescript`,
 * which a production install does not have. That is the knot the README used to
 * describe under "npm i -g github:… does not work".
 *
 * A bundle unties it. `ink`, `react` and their trees are compiled in, so the
 * committed file has no `node_modules` to find and no build step to run:
 * clone, link, use — offline, on a machine with nothing but Node.
 *
 * The cost is real and worth stating: the bundle is generated code kept in git,
 * so it goes stale the moment `src/` changes without it. `npm run bundle` is
 * part of `npm run build` for that reason, and `check-freshness` below is what
 * complains if the committed one is older than the source it came from.
 */
import { build } from 'esbuild';
import { chmodSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outfile = join(root, 'dist', 'doet.mjs');

await build({
  entryPoints: [join(root, 'src', 'cli.tsx')],
  outfile,
  bundle: true,
  platform: 'node',
  // Matches `engines.node`. The one thing built for a newer runtime is the
  // `node:sqlite` import, and that is behind a try/catch by design — see
  // `core/agents/sqlite.ts`.
  target: 'node20',
  format: 'esm',
  // ink pulls this in at the top of its devtools module, which is only ever
  // loaded under DEV=true. See `scripts/empty.mjs` for why external is not
  // enough.
  alias: { 'react-devtools-core': join(root, 'scripts', 'empty.mjs') },
  // No shebang here, deliberately. esbuild carries over the one already at the
  // top of `src/cli.tsx` and puts it first; adding another put a second
  // `#!/usr/bin/env node` on line 2, where it is not a comment but a syntax
  // error — and one that only shows up when the file is *run*, so the build
  // reports success and the clone is broken.
  banner: {
    js: [
      // Some of the bundled tree is CommonJS and calls `require`, which does
      // not exist in an ESM bundle unless it is put back.
      "import{createRequire as __doetRequire}from'node:module';",
      'const require=__doetRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'warning',
});

chmodSync(outfile, 0o755);

const size = (statSync(outfile).size / 1024 / 1024).toFixed(1);
process.stdout.write(`bundled dist/doet.mjs (${size}mb, no runtime dependencies)\n`);

/** Warns when the committed bundle is older than the source it was built from. */
export function newestSource(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestSource(path) : statSync(path).mtimeMs);
  }
  return newest;
}
