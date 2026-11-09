import { describe, expect, it } from 'vitest';
import { ResourceId } from '../../src/data/resources';
import { TileId } from '../../src/data/tiles';
import { emptyActivity } from '../../src/sim/activity';
import { formatActivity, formatTile, groupDigits } from '../../src/ui/debugOverlay';

describe('formatTile', () => {
  it('shows coordinates, terrain, resource and amount', () => {
    expect(
      formatTile({
        x: 12,
        y: -3,
        info: { terrain: TileId.Grass, resource: ResourceId.IronOre, amount: 1250 },
      }),
    ).toBe('tile (12, -3) grass · iron ore 1 250');
    expect(
      formatTile({ x: 0, y: 0, info: { terrain: TileId.Water, resource: 0, amount: 0 } }),
    ).toBe('tile (0, 0) water');
  });

  it('names the resource on an ore tile after its terrain, with grouped digits', () => {
    expect(
      formatTile({
        x: 18,
        y: -21,
        info: { terrain: TileId.Grass, resource: ResourceId.IronOre, amount: 1594 },
      }),
    ).toBe('tile (18, -21) grass · iron ore 1 594');
    expect(
      formatTile({
        x: 0,
        y: 0,
        info: { terrain: TileId.Sand, resource: ResourceId.Coal, amount: 12 },
      }),
    ).toBe('tile (0, 0) sand · coal 12');
    expect(
      formatTile({
        x: 60,
        y: 4,
        info: { terrain: TileId.Grass, resource: 0, amount: 0, tree: 1 },
      }),
    ).toBe('tile (60, 4) grass · tree');
    expect(
      formatTile({
        x: 1,
        y: 1,
        info: { terrain: TileId.Grass, resource: ResourceId.Stone, amount: 5, tree: 1 },
      }),
    ).toBe('tile (1, 1) grass · tree · stone 5');
    expect(groupDigits(0)).toBe('0');
    expect(groupDigits(999)).toBe('999');
    expect(groupDigits(1000)).toBe('1 000');
    expect(groupDigits(1234567)).toBe('1 234 567');
  });

  it('handles missing data', () => {
    expect(formatTile(null)).toBe('tile -');
    expect(formatTile({ x: 1, y: 2, info: null })).toBe('tile (1, 2) loading');
    expect(formatTile({ x: 1, y: 2, info: { terrain: 99, resource: 42, amount: 7 } })).toBe(
      'tile (1, 2) tile#99 · resource#42 7',
    );
  });
});

describe('formatActivity', () => {
  it('shows what each system stepped out of its entities, leaving out empty systems', () => {
    const activity = emptyActivity();
    expect(formatActivity(activity)).toBe('stepped -');
    activity.power = { entities: 897, awake: 239, stepped: 239 };
    activity.belts = { entities: 1008, awake: 776, stepped: 776 };
    activity.inserters = { entities: 876, awake: 40, stepped: 1459 };
    expect(formatActivity(activity)).toBe('stepped power 239/897 · lane 776/1 008 · ins 1 459/876');
  });
});
