import { describe, expect, it } from 'vitest';
import {
  ITEMS,
  ITEM_IDS,
  ItemId,
  MAX_STACK_SIZE,
  MINED_ITEM,
  itemPrototype,
  minedItem,
} from '../../src/data/items';
import { ORE_IDS, RESOURCES, ResourceId } from '../../src/data/resources';

describe('item prototypes', () => {
  it('are keyed by their own id and have valid stack sizes and names', () => {
    expect(ITEM_IDS).toEqual(
      Object.keys(ITEMS)
        .map(Number)
        .sort((a, b) => a - b),
    );
    const names = new Set<string>();
    for (const id of ITEM_IDS) {
      const proto = ITEMS[id];
      expect(proto.id).toBe(id);
      expect(Number.isInteger(proto.stackSize)).toBe(true);
      expect(proto.stackSize).toBeGreaterThanOrEqual(1);
      expect(proto.stackSize).toBeLessThanOrEqual(MAX_STACK_SIZE);
      expect(proto.color).toBe(proto.color & 0xffffff);
      expect(proto.label.length).toBeGreaterThan(0);
      names.add(proto.name);
    }
    expect(names.size).toBe(ITEM_IDS.length);
    expect(itemPrototype(ItemId.None)).toBeUndefined();
    expect(itemPrototype(999)).toBeUndefined();
  });

  it('cover the four raw resources, each mined into the item of the same name', () => {
    for (const ore of ORE_IDS) {
      const item = MINED_ITEM[ore];
      expect(ITEMS[item].name).toBe(RESOURCES[ore].name);
      expect(minedItem(ore)).toBe(item);
    }
    expect(minedItem(ResourceId.None)).toBeUndefined();
    expect(minedItem(99)).toBeUndefined();
  });
});
