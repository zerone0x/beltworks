import { describe, expect, it } from 'vitest';
import { ITEMS, ItemId } from '../../src/data/items';
import {
  countByName,
  cssColor,
  slotView,
  transferCount,
  transferFor,
} from '../../src/ui/inventory';

describe('stack transfers', () => {
  const click = (button: number, mods: { ctrlKey?: boolean; metaKey?: boolean } = {}) =>
    transferFor({ button, ctrlKey: false, metaKey: false, ...mods });

  it('map clicks to how much they move', () => {
    expect(click(0)).toBe('all');
    expect(click(0, { ctrlKey: true })).toBe('one');
    expect(click(0, { metaKey: true })).toBe('one');
    expect(click(1)).toBe('one');
    expect(click(2)).toBe('half');
    expect(click(3)).toBeNull();
  });

  it('count whole stacks, halves rounded up, and single items', () => {
    expect(transferCount(10, 'all')).toBe(10);
    expect(transferCount(10, 'half')).toBe(5);
    expect(transferCount(5, 'half')).toBe(3);
    expect(transferCount(1, 'half')).toBe(1);
    expect(transferCount(10, 'one')).toBe(1);
    expect(transferCount(0, 'one')).toBe(0);
  });
});

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
