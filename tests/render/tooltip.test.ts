import { describe, expect, it } from 'vitest';
import { EntityTypeId } from '../../src/data/entities';
import { ITEM_IDS, ItemId } from '../../src/data/items';
import { RECIPE_IDS, RecipeId } from '../../src/data/recipes';
import {
  entityTooltip,
  formatPower,
  formatSeconds,
  itemTooltip,
  recipeTooltip,
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
});
