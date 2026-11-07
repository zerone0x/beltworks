/**
 * The inserter sprites (docs/ART.md, "Inserters"), end to end, from a test
 * kit (`?kit=`, docs/DECISIONS.md, D29) with real mouse and keyboard input
 * next to the spawn: the four inserters in a row, idle with their arms at
 * rest and the electric ones on steam power, drawn with their arms and arm
 * shadows (`art-inserters` screenshots at 1× and 2× zoom).
 */

import { expect, test } from '@playwright/test';
import { Direction } from '../../src/sim/entities/direction';
import { MachineState } from '../../src/sim/entities/machine';
import { entityAt, openEntityAt, place, shoot, sprites, start, tile } from './sprites';
import { closeWindows } from './windows';

test('the four inserters side by side, with their arm shadows', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const TYPES = ['burner-inserter', 'fast-inserter', 'electric-inserter', 'long-handed-inserter'];
  const KIT = [
    ...TYPES.map((t) => `${t}:1`),
    'small-electric-pole:3',
    'boiler:1',
    'steam-engine:1',
    'coal:50',
  ].join(',');
  const errors = await start(page, KIT);
  // In a row, facing north, a tile apart (idle: arms at rest over the pickup tile), and steam
  // power wired to them as in `sceneArt.spec.ts`, so the electric ones show no alert.
  const row = TYPES.map((name, i) => ({ name, ...tile(-9 + 2 * i, -5) }));
  for (const [i, ins] of row.entries()) {
    await place(page, String(i + 1), ins, ins.name, Direction.North);
  }
  await place(page, '7', { x: 1, y: -9, w: 3, h: 5 }, 'steam-engine', Direction.North);
  const boiler = { x: 2, y: -4, w: 2, h: 3 };
  await place(page, '6', boiler, 'boiler', Direction.North);
  for (const pole of [tile(0, -4), tile(-4, -3), tile(-8, -3)]) {
    await place(page, '5', pole, 'small-electric-pole');
  }
  await openEntityAt(page, boiler, 'boiler');
  await page.locator('#entity-panel .player-inventory .slot[data-item="coal"]').first().click();
  await closeWindows(page);
  await expect.poll(async () => (await sprites(page)).arms).toBe(TYPES.length);
  for (const ins of row.slice(1)) {
    await expect
      .poll(async () => (await entityAt(page, ins.x, ins.y))?.status)
      .not.toBe(MachineState.NoPower);
  }

  const clip: [[number, number], [number, number]] = [
    [-10, -6.5],
    [-1, -2],
  ];
  await shoot(page, testInfo, 'art-inserters.png', 'inserters at 1× zoom', [-5.5, -4.5, 1], clip);
  await shoot(
    page,
    testInfo,
    'art-inserters-2x.png',
    'inserters at 2× zoom',
    [-5.5, -4.5, 2],
    clip,
  );
  expect(errors).toEqual([]);
});
