/**
 * The M1 "Done when" (docs/ROADMAP.md): from a new game with the starting
 * kit, the player builds iron ore → burner mining drill → belt → burner
 * inserter → stone furnace → burner inserter → wooden chest with real
 * keyboard and mouse input, fuels everything through the entity GUI, and the
 * chest then fills with iron plates without any further input.
 *
 * The test hook (src/testHook.ts) is only used to read state: where the
 * player stands, the ghost, the entities and belts the renderer knows, and
 * the inventory; the ore layout comes from a main-thread `World` with the
 * game's seed. Every wait polls state with generous timeouts, so the test
 * holds up on CI's slow software-rendered Chromium.
 */

import { expect, test, type Page } from '@playwright/test';
import { ItemId } from '../../src/data/items';
import { ResourceId } from '../../src/data/resources';
import { Direction } from '../../src/sim/entities/direction';
import { MachineState } from '../../src/sim/entities/machine';
import { startingPatches } from '../../src/sim/world/generate';
import { World } from '../../src/sim/world/world';
import {
  BELTS,
  countOf,
  entityAt,
  findLayout,
  ghost,
  keyFor,
  place,
  statusAt,
  tileScreen,
  zoomIn,
  type Tile,
} from './ironLine';
import { walkNear } from './walk';
import { closeWindows } from './windows';

/** Seed used by src/main.ts. */
const WORLD_SEED = 1;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

async function open(page: Page): Promise<void> {
  await page.goto('./');
  await page.waitForFunction(() => window.__beltworks?.player() != null, undefined, {
    timeout: 30_000,
  });
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 30_000,
  });
}

test('a drill, a belt, inserters, a furnace and a chest make iron plates on their own', async ({
  page,
}, testInfo) => {
  // Walking with the keyboard and building with the mouse is slow on CI's software-rendered Chromium.
  test.setTimeout(300_000);
  const errors = collectErrors(page);
  await open(page);
  await zoomIn(page);

  // Walk to the iron patch and find room for the chain around the player.
  const patch = startingPatches(WORLD_SEED).find((p) => p.ore === ResourceId.IronOre)!;
  const stand = await walkNear(page, patch.x + 0.5, patch.y + 0.5, 1.5);
  const layout = findLayout(new World(WORLD_SEED), stand.x, stand.y);
  expect(layout, `no room for the chain around (${stand.x}, ${stand.y})`).toBeDefined();
  const l = layout!;

  // Build from the chest backwards with real clicks, everything facing east.
  const E = Direction.East;
  await page.keyboard.press(keyFor(ItemId.WoodenChest));
  await place(page, 'wooden-chest', l.chest, 1);
  await page.keyboard.press(keyFor(ItemId.BurnerInserter));
  await place(page, 'burner-inserter', l.put, 1, E);
  await place(page, 'burner-inserter', l.pick, 1, E);
  await page.keyboard.press(keyFor(ItemId.StoneFurnace));
  await place(page, 'stone-furnace', l.furnace, 2);
  // The belts in one drag: place the first, then hold the button and move
  // tile by tile (waiting for each, since input is sampled once per frame).
  await page.keyboard.press(keyFor(ItemId.TransportBelt));
  const [first, ...rest] = l.belts;
  await place(page, 'transport-belt', first!, 1, E, { hold: true });
  for (const t of rest) {
    const at = await tileScreen(page, t.x, t.y);
    await page.mouse.move(at.x, at.y, { steps: 4 });
    await expect.poll(() => entityAt(page, t.x, t.y)).toMatchObject({ name: 'transport-belt' });
  }
  await page.mouse.up();
  await expect.poll(() => countOf(page, ItemId.TransportBelt)).toBe(10 - BELTS);
  await page.keyboard.press(keyFor(ItemId.BurnerMiningDrill));
  await place(page, 'burner-mining-drill', l.drill, 2, E);
  await page.keyboard.press('q');
  await expect.poll(() => ghost(page)).toBeNull();
  for (const t of [l.drill, ...l.belts, l.pick, l.put]) {
    expect((await entityAt(page, t.x, t.y))?.dir).toBe(E);
  }
  // Nothing has fuel yet.
  await expect.poll(() => statusAt(page, l.drill.x, l.drill.y)).toBe(MachineState.NoFuel);
  await expect.poll(() => statusAt(page, l.pick.x, l.pick.y)).toBe(MachineState.NoFuel);
  await expect.poll(() => statusAt(page, l.put.x, l.put.y)).toBe(MachineState.NoFuel);

  // Fuel through the GUI: right-click inserts half of the coal stack, left-click all of it.
  const panel = page.locator('#entity-panel');
  const coal = panel.locator('.player-inventory .slot[data-item="coal"]');
  const fuel = async (at: Tile, type: string, button: 'left' | 'right', left: number) => {
    const c = await tileScreen(page, at.x, at.y);
    await page.mouse.click(c.x, c.y);
    await expect(panel).toHaveAttribute('data-type', type);
    await coal.click({ button });
    // The coal left the inventory, so the machine took it. (Its fuel slot may
    // already be empty again: a machine with work to do starts burning a
    // single unit at once.)
    await expect.poll(() => countOf(page, ItemId.Coal)).toBe(left);
    await closeWindows(page);
    await expect(panel).toBeHidden();
  };
  // 10 coal: 5 for the drill (33 ores), 3 for the furnace, 1 for each inserter (33 swings).
  await fuel(l.drill, 'burner-mining-drill', 'right', 5);
  await fuel(l.furnace, 'stone-furnace', 'right', 2);
  await fuel(l.pick, 'burner-inserter', 'right', 1);
  await fuel(l.put, 'burner-inserter', 'left', 0);

  // From here on the player only watches. The chest's window shows what
  // arrives (opening it sends no command); the snapshots show the rest. It
  // replaces the inventory window, which it shows anyway.
  const inventory = page.locator('#inventory-panel');
  await page.keyboard.press('e');
  await expect(inventory).toBeVisible();
  const chest = await tileScreen(page, l.chest.x, l.chest.y);
  await page.mouse.click(chest.x, chest.y);
  await expect(panel).toHaveAttribute('data-type', 'wooden-chest');
  await expect(inventory).toBeHidden();
  // (It may hold a plate already: on a slow, loaded machine fuelling everything
  // through the GUI can take longer than the first plate.)
  const box = panel.locator('.entity-slots .slot').first();

  // The drill mines an ore every 4 s and drops it onto the belt, which carries
  // it to the first inserter.
  await expect.poll(() => statusAt(page, l.drill.x, l.drill.y)).toBe(MachineState.Working);
  // (An ore spends only a third of the drill's cycle on the belts, so this is
  // checked on every frame in the page rather than polled from here.)
  await page.waitForFunction(
    ([ore, belts]) =>
      window
        .__beltworks!.belts()
        .some(
          (b) =>
            belts.some((t) => t.x === b.x && t.y === b.y) && b.items.some((i) => i.item === ore),
        ),
    [ItemId.IronOre, l.belts] as const,
    { timeout: 60_000, polling: 'raf' },
  );
  // The inserter swings it into the furnace, which smelts it.
  await expect
    .poll(() => statusAt(page, l.furnace.x, l.furnace.y), { timeout: 60_000 })
    .toBe(MachineState.Working);
  // The second inserter moves the plates into the chest.
  await expect(box).toHaveAttribute('data-item', 'iron-plate', { timeout: 90_000 });
  const plates = async () => Number(await box.getAttribute('data-count'));
  expect(await plates()).toBeGreaterThan(0);

  // Shot while the next ore is on its way along the belt and the furnace
  // still smelts the last one (polled every frame).
  await page.waitForFunction(
    ([ore, belt, furnace, working]) =>
      window
        .__beltworks!.belts()
        .some(
          (b) =>
            b.x === belt.x &&
            b.y === belt.y &&
            b.items.some((i) => i.item === ore && i.offset > 128),
        ) &&
      window
        .__beltworks!.entities()
        .some((e) => e.x === furnace.x && e.y === furnace.y && e.status === working),
    [ItemId.IronOre, l.belts[1]!, l.furnace, MachineState.Working] as const,
    { timeout: 60_000, polling: 'raf' },
  );
  const shot = testInfo.outputPath('m1-chain.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('the M1 automation chain filling a chest with iron plates', {
    path: shot,
    contentType: 'image/png',
  });
  // And it keeps going: more plates arrive, still without any input.
  const before = await plates();
  await expect.poll(plates, { timeout: 90_000 }).toBeGreaterThan(before);

  // The plates came out of the chain, not out of the player's pockets.
  expect(await countOf(page, ItemId.IronOre)).toBe(0);
  expect(await countOf(page, ItemId.IronPlate)).toBe(0);
  // E closes the chest's window (rather than opening a second inventory).
  await page.keyboard.press('e');
  await expect(panel).toBeHidden();
  await expect(inventory).toBeHidden();
  expect(errors).toEqual([]);
});
