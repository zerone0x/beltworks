import { describe, expect, it } from 'vitest';
import { ITEM_IDS, ITEMS, ItemId } from '../../src/data/items';
import { ICON_PX, iconPixels, iconSpec } from '../../src/render/itemIcons';

/** The icon as rows of `.` (transparent) and `#` (opaque), for readable assertions. */
const mask = (item: number): string[] => {
  const px = iconPixels(item);
  const rows: string[] = [];
  for (let y = 0; y < ICON_PX; y++) {
    let row = '';
    for (let x = 0; x < ICON_PX; x++) row += px[(y * ICON_PX + x) * 4 + 3] ? '#' : '.';
    rows.push(row);
  }
  return rows;
};

const rgb = (item: number, x: number, y: number): number => {
  const px = iconPixels(item);
  const o = (y * ICON_PX + x) * 4;
  return (px[o]! << 16) | (px[o + 1]! << 8) | px[o + 2]!;
};

describe('item icons', () => {
  it('give every item a short label, and no two items the same look', () => {
    const looks = new Set<string>();
    for (const id of ITEM_IDS) {
      const { label, shape } = iconSpec(id);
      expect(label).toMatch(/^[A-Z12?]{1,2}$/);
      // Same label and shape only with clearly different colors (none so far).
      looks.add(`${label}:${shape}`);
    }
    expect(looks.size).toBe(ITEM_IDS.length);
  });

  it('tell ores from plates by shape', () => {
    expect(iconSpec(ItemId.IronOre)).toEqual({ label: 'FE', shape: 'ore' });
    expect(iconSpec(ItemId.IronPlate)).toEqual({ label: 'FE', shape: 'plate' });
    // An ore chunk has its corners cut; a plate fills the square.
    expect(mask(ItemId.IronOre)[0]).toBe('...#######...');
    expect(mask(ItemId.IronPlate)[0]).toBe('#'.repeat(ICON_PX));
  });

  it('fill the shape with the item color and draw the label on it', () => {
    const center = Math.floor(ICON_PX / 2);
    // Coal's single letter `C` leaves the center column of its glyph open.
    expect(rgb(ItemId.Coal, center, center)).toBe(ITEMS[ItemId.Coal].color);
    // Its top row is set: `.##` starting at column 5, row 4.
    expect(rgb(ItemId.Coal, 6, 4)).not.toBe(ITEMS[ItemId.Coal].color);
    // Light text on dark items, dark text on light ones.
    const text = (item: number) => {
      const c = rgb(item, 6, 4);
      return ((c >> 16) & 0xff) + ((c >> 8) & 0xff) + (c & 0xff);
    };
    expect(text(ItemId.Coal)).toBeGreaterThan(600);
    expect(text(ItemId.Stone)).toBeLessThan(150);
  });

  it('show `?` for unknown ids', () => {
    expect(iconSpec(999)).toEqual({ label: '?', shape: 'item' });
    expect(iconPixels(999)).toHaveLength(ICON_PX * ICON_PX * 4);
  });
});
