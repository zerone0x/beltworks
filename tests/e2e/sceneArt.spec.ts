/**
 * The logistics sprites (docs/ART.md, "Belts", "Inserters", "Poles"), end to
 * end, from a test kit (`?kit=`, docs/DECISIONS.md, D29) with real mouse and
 * keyboard input next to the spawn: a clockwise belt loop (straight belts and
 * curves), a burner and a long-handed inserter feeding it coal from chests, an
 * electric and a fast inserter taking it off into chests, and steam power with
 * poles wired across the scene. Belts, inserters (with their arms) and poles
 * are drawn with sprites, the arms swing and hold items (`art-logistics`
 * screenshots at 1× and 2× zoom), and the scene keeps a good part of the
 * frame rate of bare terrain.
 *
 * The other logistics sprite specs: `beltTiersArt.spec.ts` and
 * `insertersArt.spec.ts` (each in its own file so the long sprite specs land in
 * different CI shards; docs/TOOLING.md, "End-to-end tests").
 */

import { expect, test } from '@playwright/test';
import { TILE_PX } from '../../src/render/camera';
import { Direction } from '../../src/sim/entities/direction';
import { MachineState } from '../../src/sim/entities/machine';
import {
  belts,
  entityAt,
  openEntityAt,
  place,
  shoot,
  sprites,
  start,
  tile,
  type Rect,
} from './sprites';
import { sceneFps } from './walk';
import { closeWindows } from './windows';

/** A clockwise loop over x -7..-4, y -7..-4: each belt and the way it faces. */
const LOOP: [number, number, Direction][] = [
  [-7, -7, Direction.East],
  [-6, -7, Direction.East],
  [-5, -7, Direction.East],
  [-4, -7, Direction.South],
  [-4, -6, Direction.South],
  [-4, -5, Direction.South],
  [-4, -4, Direction.West],
  [-5, -4, Direction.West],
  [-6, -4, Direction.West],
  [-7, -4, Direction.North],
  [-7, -5, Direction.North],
  [-7, -6, Direction.North],
];

/** Inserters around the loop, the chests they work with, and the power (all in build reach of the spawn). */
const SCENE = {
  coalChest: tile(-6, -2),
  // Coal from the chest onto the loop's bottom row.
  burner: { ...tile(-6, -3), dir: Direction.North },
  // Off the loop's right side into a chest east of it.
  electric: { ...tile(-3, -5), dir: Direction.East },
  electricChest: tile(-2, -5),
  // Off the top row into a chest north of it.
  fast: { ...tile(-5, -8), dir: Direction.North },
  fastChest: tile(-5, -9),
  // More coal from a chest two tiles south onto the bottom-left corner, two tiles north.
  long: { ...tile(-7, -2), dir: Direction.North },
  longChest: tile(-7, 0),
  engine: { x: 1, y: -9, w: 3, h: 5 },
  boiler: { x: 2, y: -4, w: 2, h: 3 },
  poles: [tile(0, -4), tile(-3, -3), tile(-4, -9), tile(-8, -1)],
} as const;

test('belts, inserters and poles are drawn with their pre-rendered sprites', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const KIT = [
    'transport-belt:20',
    'burner-inserter:1',
    'electric-inserter:1',
    'fast-inserter:1',
    'long-handed-inserter:1',
    'wooden-chest:4',
    'small-electric-pole:4',
    'boiler:1',
    'steam-engine:1',
    'coal:200',
  ].join(',');
  const KEY = {
    belt: '1',
    burner: '2',
    electric: '3',
    fast: '4',
    long: '5',
    chest: '6',
    pole: '7',
    boiler: '8',
    engine: '9',
  } as const;
  const errors = await start(page, KIT);
  const panel = page.locator('#entity-panel');
  const openAt = (r: Rect, name: string) => openEntityAt(page, r, name);

  for (const [x, y, dir] of LOOP) await place(page, KEY.belt, tile(x, y), 'transport-belt', dir);
  for (const chest of [SCENE.coalChest, SCENE.electricChest, SCENE.fastChest, SCENE.longChest]) {
    await place(page, KEY.chest, chest, 'wooden-chest');
  }
  await place(page, KEY.burner, SCENE.burner, 'burner-inserter', SCENE.burner.dir);
  await place(page, KEY.electric, SCENE.electric, 'electric-inserter', SCENE.electric.dir);
  await place(page, KEY.fast, SCENE.fast, 'fast-inserter', SCENE.fast.dir);
  await place(page, KEY.long, SCENE.long, 'long-handed-inserter', SCENE.long.dir);
  // Steam power (models from the power atlas).
  await place(page, KEY.engine, SCENE.engine, 'steam-engine', Direction.North);
  await place(page, KEY.boiler, SCENE.boiler, 'boiler', Direction.North);
  for (const pole of SCENE.poles) await place(page, KEY.pole, pole, 'small-electric-pole');

  // Coal for the boiler, and for the burner and long-handed inserters to put on the belt.
  await openAt(SCENE.boiler, 'boiler');
  await panel.locator('.player-inventory .slot[data-item="coal"]').first().click();
  for (const chest of [SCENE.coalChest, SCENE.longChest]) {
    await openAt(chest, 'wooden-chest');
    await panel.locator('.player-inventory .slot[data-item="coal"]').first().click();
  }
  await closeWindows(page);
  await expect(panel).toBeHidden();

  // Belts, inserters (with arms) and poles are sprites; the electric inserters have power.
  await expect.poll(async () => (await sprites(page)).belts).toBe(LOOP.length);
  await expect.poll(async () => (await sprites(page)).arms).toBe(4);
  for (const ins of [SCENE.electric, SCENE.fast, SCENE.long]) {
    await expect
      .poll(async () => (await entityAt(page, ins.x, ins.y))?.status)
      .not.toBe(MachineState.NoPower);
  }
  // Coal goes round the loop, and the inserters move it.
  await expect
    .poll(async () => (await belts(page)).reduce((n, b) => n + b.items.length, 0), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.__beltworks!.inserters())).some((i) => i.held > 0),
      { timeout: 30_000 },
    )
    .toBe(true);

  // At 1× cropped to the scene (its tiles, the tall poles and their shadows), and at 2×.
  await shoot(
    page,
    testInfo,
    'art-logistics.png',
    'belts, inserters and poles at 1× zoom',
    [-2.5, -4.5, 1],
    [
      [-10.5, -11],
      [4.5, 1.5],
    ],
  );
  await shoot(
    page,
    testInfo,
    'art-logistics-2x.png',
    'belts, inserters and poles at 2× zoom',
    [-2.5, -4.5, 2],
  );
  // Sprites don't slow the frame rate down to a crawl: the scene (which also
  // draws the animated steam power sprites) keeps a good part of the frame
  // rate of bare terrain on the same page. CI renders in software on runners
  // of varying speed, so this is a ratio, not an absolute floor.
  const rate = await sceneFps(page, [-2.5 * TILE_PX, -4.5 * TILE_PX, 1]);
  expect(
    rate.scene,
    `${String(rate.scene)} fps, bare terrain ${String(rate.bare)}`,
  ).toBeGreaterThanOrEqual(rate.bare * 0.35);
  expect(errors).toEqual([]);
});
