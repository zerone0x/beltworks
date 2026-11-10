import { describe, expect, it } from 'vitest';
import { EntityTypeId, entityPrototype } from '../../src/data/entities';
import { ITEM_IDS, ItemId } from '../../src/data/items';
import { RECIPE_IDS, RecipeId } from '../../src/data/recipes';
import { ResourceId } from '../../src/data/resources';
import {
  DrillAreaOreCache,
  drillAreaOre,
  drillAreaTooltip,
  entityTooltip,
  formatPower,
  formatSeconds,
  itemTooltip,
  recipeTooltip,
  resourceTooltip,
  tooltipFor,
} from '../../src/ui/tooltip';

describe('tooltips', () => {
  it('format times and power', () => {
    expect(formatSeconds(30)).toBe('0.5 s');
    expect(formatSeconds(192)).toBe('3.2 s');
    expect(formatSeconds(600)).toBe('10 s');
    expect(formatPower(1_500)).toBe('90 kW');
    expect(formatPower(30_000)).toBe('1.8 MW');
    expect(formatPower(7)).toBe('420 W');
  });

  it('show an item’s recipe, crafting time and, for a machine, its power use', () => {
    expect(itemTooltip(ItemId.BurnerMiningDrill)).toEqual({
      title: 'Burner mining drill',
      lines: [
        '3 × Iron gear wheel, 3 × Iron plate, 1 × Stone furnace → 1 × Burner mining drill',
        'Crafting time 2 s (by hand or in an assembler)',
        'Size 2×2',
        'Power 150 kW, burns fuel',
        'Mines 1 ore every 4 s',
      ],
    });
    const plate = itemTooltip(ItemId.IronPlate)!;
    expect(plate.lines).toContain('1 × Iron ore → 1 × Iron plate');
    expect(plate.lines).toContain('Crafting time 3.2 s (in a furnace)');
    expect(itemTooltip(ItemId.Coal)!.lines).toEqual([
      'Mined by hand or by a mining drill',
      'Fuel value 4 MJ',
    ]);
    expect(itemTooltip(ItemId.ElectricInserter)!.lines).toContain(
      'Power 13.2 kW electric, 420 W idle',
    );
    expect(itemTooltip(ItemId.SteamEngine)!.lines).toContain('Produces up to 900 kW');
  });

  it('show a recipe with what its result does, and an entity with its set recipe', () => {
    const furnace = recipeTooltip(RecipeId.StoneFurnace)!;
    expect(furnace.title).toBe('Stone furnace');
    expect(furnace.lines.slice(0, 2)).toEqual([
      '5 × Stone → 1 × Stone furnace',
      'Crafting time 0.5 s (by hand or in an assembler)',
    ]);
    expect(furnace.lines).toContain('Power 90 kW, burns fuel');
    const assembler = entityTooltip(EntityTypeId.AssemblingMachine1, RecipeId.IronGearWheel)!;
    expect(assembler.lines).toContain('Crafting speed 0.5');
    expect(assembler.lines).toContain('Making Iron gear wheel: 1 s');
  });

  it('show how long a recipe takes in the machine picking it (the assembler recipe picker)', () => {
    const tip = `recipe:${String(RecipeId.IronGearWheel)}@${String(EntityTypeId.AssemblingMachine2)}`;
    const gear = tooltipFor(tip)!;
    expect(gear.title).toBe('Iron gear wheel');
    expect(gear.lines).toContain('In Assembling machine 2: 0.7 s');
    expect(recipeTooltip(RecipeId.IronGearWheel, EntityTypeId.AssemblingMachine1)!.lines).toContain(
      'In Assembling machine 1: 1 s',
    );
    // Without a machine (hand recipes), or with one that doesn't craft, no such line.
    expect(recipeTooltip(RecipeId.IronGearWheel)!.lines.some((l) => l.startsWith('In '))).toBe(
      false,
    );
    expect(
      recipeTooltip(RecipeId.IronGearWheel, EntityTypeId.StoneFurnace)!.lines.some((l) =>
        l.startsWith('In '),
      ),
    ).toBe(false);
    expect(tooltipFor(`item:${String(ItemId.Coal)}@1`)).toBeNull();
  });

  it('cover every item and recipe, and parse data-tip values', () => {
    for (const id of ITEM_IDS) expect(itemTooltip(id)?.title).toBeTruthy();
    for (const id of RECIPE_IDS) expect(recipeTooltip(id)?.lines.length).toBeGreaterThan(1);
    expect(tooltipFor(`item:${String(ItemId.Coal)}`)?.title).toBe('Coal');
    expect(tooltipFor(`entity:${String(EntityTypeId.StoneFurnace)}`)?.title).toBe('Stone furnace');
    expect(tooltipFor('bogus:1')).toBeNull();
    expect(tooltipFor('item:9999')).toBeNull();
  });

  it('show a resource tile with the amount left', () => {
    expect(resourceTooltip(ResourceId.IronOre, 1_594)).toEqual({
      title: 'Iron ore',
      lines: ['1 594 left'],
    });
    expect(resourceTooltip(ResourceId.Coal, 12)).toEqual({ title: 'Coal', lines: ['12 left'] });
    expect(resourceTooltip(ResourceId.Stone, 1_250_000)?.lines).toEqual(['1 250 000 left']);
    expect(resourceTooltip(ResourceId.None, 0)).toBeNull();
  });

  it('sum the ore in the area a mining drill ghost would mine', () => {
    // Iron on x < 0, copper on 0 ≤ x < 50 between y = 0 and 9 (100 units a tile), stone at
    // (1, 1); x ≥ 50 not received yet.
    const world = (x: number, y: number) => {
      if (x >= 50) return null;
      if (y < 0 || y > 9) return { resource: 0, amount: 0 };
      if (x === 1 && y === 1) return { resource: ResourceId.Stone, amount: 7 };
      return { resource: x < 0 ? ResourceId.IronOre : ResourceId.CopperOre, amount: 100 };
    };
    // The electric drill at (-1, 0) mines the 5×5 from (-2, -1): 2 iron columns, 3 copper ones, rows 0–3.
    const electric = entityPrototype(EntityTypeId.ElectricMiningDrill)!;
    const ore = drillAreaOre(electric, -1, 0, world);
    expect(ore).toEqual([
      { resource: ResourceId.IronOre, amount: 800 },
      { resource: ResourceId.CopperOre, amount: 1_100 },
      { resource: ResourceId.Stone, amount: 7 },
    ]);
    expect(drillAreaTooltip(electric, ore)).toEqual({
      title: 'Electric mining drill',
      lines: ['Ore in its 5×5 area:', 'Iron ore 800', 'Copper ore 1 100', 'Stone 7'],
    });
    // The burner drill mines its own 2×2 footprint.
    const burner = entityPrototype(EntityTypeId.BurnerMiningDrill)!;
    expect(drillAreaOre(burner, -1, 9, world)).toEqual([
      { resource: ResourceId.IronOre, amount: 100 },
      { resource: ResourceId.CopperOre, amount: 100 },
    ]);
    // No ore, or tiles not received yet, count as none.
    expect(drillAreaOre(burner, 49, 20, world)).toEqual([]);
    expect(drillAreaOre(burner, 50, 5, world)).toEqual([]);
    expect(drillAreaTooltip(burner, [])).toEqual({
      title: 'Burner mining drill',
      lines: ['No ore in its 2×2 area'],
    });
  });

  it("keep a drill area's ore until the drill, the spot or a chunk under it changes", () => {
    let amount = 100;
    let sums = 0;
    const world = (x: number, y: number) => {
      sums++;
      return { resource: ResourceId.IronOre, amount: x === 31 && y === 0 ? amount : 100 };
    };
    // One object per chunk, replaced when the chunk changes (as `TerrainLayer.chunkData`).
    const chunks = new Map<string, object>();
    const chunkAt = (cx: number, cy: number) => {
      const key = `${String(cx)},${String(cy)}`;
      if (!chunks.has(key)) chunks.set(key, {});
      return chunks.get(key)!;
    };
    const electric = entityPrototype(EntityTypeId.ElectricMiningDrill)!;
    const burner = entityPrototype(EntityTypeId.BurnerMiningDrill)!;
    const cache = new DrillAreaOreCache();
    // At (31, 0) the 5×5 area (30-34, -1-3) spans four chunks.
    cache.update(electric, 31, 0, world, chunkAt);
    expect(cache.ore).toEqual(drillAreaOre(electric, 31, 0, world));
    expect(cache.oreKey).toBe(`${String(ResourceId.IronOre)}=2500`);
    sums = 0;
    cache.update(electric, 31, 0, world, chunkAt);
    expect(sums).toBe(0);
    // A chunk under the area arrives again, with less ore on (31, 0).
    amount = 40;
    chunks.set('0,0', {});
    cache.update(electric, 31, 0, world, chunkAt);
    expect(sums).toBeGreaterThan(0);
    expect(cache.ore).toEqual([{ resource: ResourceId.IronOre, amount: 2_440 }]);
    // A chunk outside it changes: nothing to sum again.
    sums = 0;
    chunks.set('5,5', {});
    cache.update(electric, 31, 0, world, chunkAt);
    expect(sums).toBe(0);
    // Another spot, another drill.
    cache.update(electric, 32, 0, world, chunkAt);
    expect(sums).toBeGreaterThan(0);
    expect(cache.update(burner, 32, 0, world, chunkAt).ore).toEqual([
      { resource: ResourceId.IronOre, amount: 400 },
    ]);
  });
});
