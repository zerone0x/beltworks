/**
 * Which recipes a force (a team of players) may use. The hook for research
 * (M3): until technologies exist every recipe is unlocked; the research
 * system will keep a researched set per force in `SimState` and answer from
 * it here, so every caller (the `SetRecipe` command, the assembling
 * machine's recipe picker through the entity detail, and later hand
 * crafting) follows it without changes.
 *
 * Forces: there is a single one for now, so every player belongs to
 * {@link DEFAULT_FORCE}.
 */

import { recipePrototype } from '../../data/recipes';
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
 * recipe ids and forces). Every recipe, until research lands.
 */
export function isRecipeUnlocked(_state: SimState, force: number, recipe: number): boolean {
  return force === DEFAULT_FORCE && recipePrototype(recipe) !== undefined;
}
