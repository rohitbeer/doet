/**
 * The `prepare` step, which has to survive two very different installs.
 *
 * A developer clone runs `npm install` with devDependencies, so `typescript`
 * and `esbuild` are there and everything is built from source.
 *
 * A *use* clone runs `npm install --omit=dev`, or nothing at all. There is no
 * compiler, and there does not need to be: `dist/doet.mjs` is committed and is
 * the whole program. The old `prepare` ran `tsc` unconditionally and so failed
 * exactly there, with `sh: tsc: command not found` and exit 127 — which is what
 * the README meant by "npm i -g github:BeerJii/doet does not work".
 *
 * So this builds when it can and steps aside when it cannot, rather than
 * failing an install that had everything it needed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hasCompiler = existsSync(join(root, 'node_modules', 'typescript'));
const hasBundler = existsSync(join(root, 'node_modules', 'esbuild'));
const hasBundle = existsSync(join(root, 'dist', 'doet.mjs'));

if (!hasCompiler || !hasBundler) {
  if (hasBundle) {
    process.stdout.write('doet: using the committed bundle; nothing to build.\n');
    process.exit(0);
  }
  process.stderr.write(
    'doet: no build tools and no committed bundle in dist/doet.mjs.\n' +
      'Install with devDependencies (plain `npm install`) to build from source.\n',
  );
  process.exit(1);
}

const run = (command, args) =>
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });

run('npm', ['run', 'build:tsc']);
run('npm', ['run', 'bundle']);
