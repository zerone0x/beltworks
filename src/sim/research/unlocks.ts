/**
 * Which recipes a force (a team of players) may use: those no technology
 * unlocks (available from the start), and those of the technologies it has
 * researched (src/data/technologies.ts, research state in research.ts).
 * Every caller follows it: the `SetRecipe` command and the assembling
 * machine's recipe picker (through the entity detail), and hand crafting,
 * intermediates included (src/sim/crafting/queue.ts).
 *
 * Forces: there is a single one for now, so every player belongs to
 * {@link DEFAULT_FORCE}.
 */

import { recipePrototype } from '../../data/recipes';
import { recipeUnlockedBy } from '../../data/technologies';
import type { SimState } from '../state';

/** The force every player belongs to while there is only one. */
export const DEFAULT_FORCE = 0;
/** The force of a player id with no player: it has unlocked nothing. */
export const NO_FORCE = -1;

/** The force player `playerId` belongs to ({@link NO_FORCE} for unknown players). */
export function forceOf(state: SimState, playerId: number): number {
  return state.players.has(playerId) ? DEFAULT_FORCE : NO_FORCE;
}

/**
 * Whether force `force` has unlocked recipe `recipe` (false for unknown
 * recipe ids and forces).
 */
export function isRecipeUnlocked(state: SimState, force: number, recipe: number): boolean {
  return (
    force === DEFAULT_FORCE &&
    recipePrototype(recipe) !== undefined &&
    recipeUnlockedBy((tech) => state.research.isResearched(force, tech), recipe)
  );
}
