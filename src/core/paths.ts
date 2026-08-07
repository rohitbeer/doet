import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Root for everything doet keeps between runs.
 *
 * `DOET_HOME` exists so a doet under development can be pointed somewhere
 * else. Without it, running a branch build writes its config into the same
 * `~/.doet/config.json` an installed doet reads on next launch. Even though
 * config loading validates known fields, a development build should not share
 * mutable state with an installed build. Developing doet with doet is the
 * normal case here, so the two need separate homes.
 */
export const DOET_HOME = process.env.DOET_HOME || join(homedir(), '.doet');
