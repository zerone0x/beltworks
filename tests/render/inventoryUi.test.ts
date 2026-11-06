import { describe, expect, it } from 'vitest';
import { ITEMS, ItemId } from '../../src/data/items';
import { countByName, cssColor, slotView } from '../../src/ui/inventory';

describe('slotView', () => {
  it('shows the item color, count and label', () => {
    expect(slotView({ item: ItemId.CopperOre, count: 12 })).toEqual({
      name: 'copper-ore',
      color: cssColor(ITEMS[ItemId.CopperOre].color),
      count: '12',
      title: 'Copper ore × 12',
    });
  });

  it('shows empty and unknown slots', () => {
    expect(slotView({ item: 0, count: 0 })).toEqual({
      name: '',
      color: null,
      count: '',
      title: 'Empty',
    });
    expect(slotView({ item: 999, count: 1 }).color).toBe('#ff00ff');
  });
});

describe('cssColor', () => {
  it('pads to six hex digits', () => {
    expect(cssColor(0x00a0ff)).toBe('#00a0ff');
    expect(cssColor(0)).toBe('#000000');
  });
});

describe('countByName', () => {
  it('sums an item across slots', () => {
    const slots = [
      { item: ItemId.Coal, count: 50 },
      { item: ItemId.Stone, count: 3 },
      { item: ItemId.Coal, count: 7 },
      { item: 0, count: 0 },
    ];
    expect(countByName(slots, 'coal')).toBe(57);
    expect(countByName(slots, 'stone')).toBe(3);
    expect(countByName(slots, 'iron-ore')).toBe(0);
  });
});
