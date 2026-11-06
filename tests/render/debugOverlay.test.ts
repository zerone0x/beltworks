import { describe, expect, it } from 'vitest';
import { ResourceId } from '../../src/data/resources';
import { TileId } from '../../src/data/tiles';
import { formatTile } from '../../src/ui/debugOverlay';

describe('formatTile', () => {
  it('shows coordinates, terrain, resource and amount', () => {
    expect(
      formatTile({
        x: 12,
        y: -3,
        info: { terrain: TileId.Grass, resource: ResourceId.IronOre, amount: 1250 },
      }),
    ).toBe('tile (12, -3) grass | iron-ore 1250');
    expect(
      formatTile({ x: 0, y: 0, info: { terrain: TileId.Water, resource: 0, amount: 0 } }),
    ).toBe('tile (0, 0) water');
  });

  it('handles missing data', () => {
    expect(formatTile(null)).toBe('tile -');
    expect(formatTile({ x: 1, y: 2, info: null })).toBe('tile (1, 2) loading');
    expect(formatTile({ x: 1, y: 2, info: { terrain: 99, resource: 42, amount: 7 } })).toBe(
      'tile (1, 2) tile#99 | resource#42 7',
    );
  });
});
