/**
 * The belt sprites of every tier (docs/ART.md, "Belts"), end to end, from a
 * test kit (`?kit=`, docs/DECISIONS.md, D29) with real mouse and keyboard
 * input next to the spawn: a line of each belt tier with an underground pair
 * and a curve, carrying coal. Every belt is drawn with sprites, the
 * undergrounds with their hoods (`art-logistics-belts` screenshot at 1×).
 */

import { expect, test } from '@playwright/test';
import { ItemId } from '../../src/data/items';
import { UndergroundMode } from '../../src/sim/belts/underground';
import { Direction } from '../../src/sim/entities/direction';
import { belts, place, shoot, sprites, start, tile } from './sprites';

test('every belt tier, curves and underground belts are drawn with sprites', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const TIERS = [
    { belt: 'transport-belt', underground: 'underground-belt', x: 1 },
    { belt: 'fast-transport-belt', underground: 'fast-underground-belt', x: 4 },
    { belt: 'express-transport-belt', underground: 'express-underground-belt', x: 7 },
  ];
  // Keys 1–3 the belts, 4–6 the undergrounds.
  const KIT = [
    ...TIERS.map((t) => `${t.belt}:10`),
    ...TIERS.map((t) => `${t.underground}:2`),
    'coal:50',
  ].join(',');
  const errors = await start(page, KIT);
  const { North, East } = Direction;

  // Each tier: north from y = 3, under the ground from y = 1 to y = -3, then a
  // curve east at y = -5 and one more belt.
  for (const [i, t] of TIERS.entries()) {
    const beltKey = String(i + 1);
    const undergroundKey = String(i + 4);
    for (const y of [3, 2]) await place(page, beltKey, tile(t.x, y), t.belt, North);
    await place(page, undergroundKey, tile(t.x, 1), t.underground, North);
    await place(page, undergroundKey, tile(t.x, -3), t.underground, North);
    for (const y of [-4, -5]) await place(page, beltKey, tile(t.x, y), t.belt, North);
    await place(page, beltKey, tile(t.x + 1, -5), t.belt, East);
    expect((await belts(page)).find((b) => b.x === t.x && b.y === -3)?.mode).toBe(
      UndergroundMode.Exit,
    );
  }
  // Every belt is a sprite. Coal dropped at the start of every line comes up out of its exit.
  await expect.poll(async () => (await sprites(page)).belts).toBe(TIERS.length * 7);
  for (let k = 0; k < 6; k++) {
    for (const t of TIERS) {
      await page.evaluate(
        ([x, item]) => window.__beltworks!.dropOnBelt(x!, 3, item!, 2),
        [t.x, ItemId.Coal],
      );
    }
    await page.waitForTimeout(250);
  }
  await expect
    .poll(
      async () => {
        const all = await belts(page);
        return TIERS.every((t) =>
          all.some((b) => b.x - t.x <= 1 && b.x >= t.x && b.y <= -4 && b.items.length > 0),
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  await shoot(
    page,
    testInfo,
    'art-logistics-belts.png',
    'belt tiers and undergrounds at 1× zoom',
    [4.5, -1, 1],
    [
      [-0.5, -7],
      [10.5, 4.5],
    ],
  );
  expect(errors).toEqual([]);
});
