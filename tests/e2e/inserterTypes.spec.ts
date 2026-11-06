/**
 * The M3 inserters and the iron chest, built at the spawn from a test kit
 * (`?kit=`, docs/DECISIONS.md, D29): the long-handed inserter's ghost marks
 * the tiles 2 away it picks up from and drops onto, placed it draws a long
 * arm and shows no power, and an iron chest opens with 32 slots.
 */

import { expect, test, type Page } from '@playwright/test';
import { EntityTypeId, SAT_ONE } from '../../src/data/entities';
import { Direction } from '../../src/sim/entities/direction';
import { MachineState } from '../../src/sim/entities/machine';

const KIT = 'long-handed-inserter:2,iron-chest:2,fast-inserter:2';
const KEY = { long: '1', chest: '2', fast: '3' } as const;

const tileScreen = (page: Page, x: number, y: number) =>
  page.evaluate(([tx, ty]) => window.__beltworks!.tileToScreen(tx!, ty!), [x, y]);
const entityAt = async (page: Page, x: number, y: number) =>
  (await page.evaluate(() => window.__beltworks!.entities())).find(
    (e) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h,
  );
const ghost = (page: Page) => page.evaluate(() => window.__beltworks!.ghost());

test('a long-handed inserter reaches 2 tiles, and an iron chest holds 32 stacks', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(`./?kit=${KIT}`);
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 10_000,
  });

  /** Selects the item on hotbar key `key` (unless it is selected) and turns its ghost on `(x, y)` to `dir`. */
  const aim = async (key: string, x: number, y: number, dir: Direction, name: string) => {
    const selected = await page.evaluate(() => window.__beltworks!.selectedSlot());
    if (selected !== Number(key) - 1) await page.keyboard.press(key);
    const at = await tileScreen(page, x, y);
    await page.mouse.move(at.x, at.y);
    await expect.poll(async () => (await ghost(page))?.name).toBe(name);
    while ((await ghost(page))?.dir !== dir) {
      await page.keyboard.press('r');
      await page.waitForTimeout(50);
    }
    await expect.poll(() => ghost(page)).toMatchObject({ x, y, valid: true });
    return at;
  };

  // The ghost marks its pickup and drop tiles 2 behind and 2 in front of it.
  await aim(KEY.long, 0, 3, Direction.East, 'long-handed-inserter');
  expect(await ghost(page)).toMatchObject({ pickup: { x: -2, y: 3 }, drop: { x: 2, y: 3 } });
  const at = await aim(KEY.long, 0, 3, Direction.South, 'long-handed-inserter');
  expect(await ghost(page)).toMatchObject({ pickup: { x: 0, y: 1 }, drop: { x: 0, y: 5 } });
  // A fast inserter's reach is 1.
  await aim(KEY.fast, 0, 3, Direction.South, 'fast-inserter');
  expect(await ghost(page)).toMatchObject({ pickup: { x: 0, y: 2 }, drop: { x: 0, y: 4 } });

  // Placed: a 25-tick swing in 1/65536 ticks, and no power without a pole.
  await aim(KEY.long, 0, 3, Direction.South, 'long-handed-inserter');
  await page.mouse.click(at.x, at.y);
  await expect.poll(async () => (await entityAt(page, 0, 3))?.status).toBe(MachineState.NoPower);
  await expect
    .poll(() => page.evaluate(() => window.__beltworks!.inserters()))
    .toEqual([
      expect.objectContaining({
        x: 0,
        y: 3,
        type: EntityTypeId.LongHandedInserter,
        span: 25 * SAT_ONE,
      }),
    ]);

  // An iron chest on its drop tile opens with 32 slots.
  const chestAt = await aim(KEY.chest, 0, 5, Direction.North, 'iron-chest');
  await page.mouse.click(chestAt.x, chestAt.y);
  await expect.poll(async () => (await entityAt(page, 0, 5))?.name).toBe('iron-chest');
  await page.keyboard.press('q');
  await expect.poll(() => page.evaluate(() => window.__beltworks!.selectedSlot())).toBeNull();
  await page.mouse.click(chestAt.x, chestAt.y);
  const panel = page.locator('#entity-panel');
  await expect(panel).toHaveAttribute('data-type', 'iron-chest');
  await expect(panel.locator('.entity-slots .slot')).toHaveCount(32);
  expect(errors).toEqual([]);
});
