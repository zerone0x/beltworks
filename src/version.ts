/**
 * The game's version, shown on the title screen, in the game menu and in
 * About (D61). Its one source is `version` in package.json: a named import
 * from JSON, which the bundler replaces with the string alone (nothing else
 * of package.json ships).
 */

import { version } from '../package.json';

export const VERSION: string = version;

/** The version as players see it: `v1.0.0-beta.1`. */
export const VERSION_LABEL = `v${VERSION}`;
