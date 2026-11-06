/**
 * Trees: the source of wood. The map generator places them on grass outside
 * the starting area (src/sim/world/trees.ts); players hand-mine them like a
 * resource tile, and they block building until they are gone.
 */

import { ItemId, type RealItemId } from './items';

/** The item a tree gives. */
export const TREE_ITEM: RealItemId = ItemId.Wood;
/** Units of {@link TREE_ITEM} one tree gives; mining it takes the whole tree. */
export const TREE_WOOD = 4;
/** Ticks of hand-mining to fell one tree (0.5 s, like one unit of ore). */
export const TREE_MINING_TICKS = 30;

/** Placeholder colors (0xRRGGBB): the canopy, its lit side, and the trunk. */
export const TREE_CANOPY_COLOR = 0x2f5a26;
export const TREE_CANOPY_LIGHT = 0x3e7333;
export const TREE_TRUNK_COLOR = 0x5a3b1e;
