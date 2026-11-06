/**
 * Machine states shared by every entity type that works on its own (furnaces,
 * mining drills and inserters, burner and electric, and assembling
 * machines; labs later). See docs/ARCHITECTURE.md,
 * "Machine sleep": a machine that isn't `Working` leaves its system's active
 * list until something it waits on changes.
 *
 * Stored as a uint8 in entity tables and sent to the renderer in snapshots;
 * the values must stay stable. Types that need more states add them here
 * with new values.
 */

export const MachineState = {
  /** Not a machine, or nothing to report (chests). */
  Idle: 0,
  Working: 1,
  /** Nothing to work on (no ingredients). */
  NoInput: 2,
  /** Has work but no energy left. */
  NoFuel: 3,
  /** The result has nowhere to go. */
  OutputFull: 4,
  /** A mining drill with no resource left under it. Permanent: resources never grow back. */
  Depleted: 5,
  /** An inserter at its pickup tile with nothing there that its target takes. */
  WaitingForSource: 6,
  /** An inserter whose drop tile has no entity, or one that won't take the held item yet. */
  WaitingForTarget: 7,
  /** A power producer (boiler, steam engine) that could deliver energy, but none is drawn. */
  NoDemand: 8,
  /**
   * An electric machine with work to do whose network gives it no power
   * (not connected, or satisfaction 0). Unlike the other waiting states it
   * stays on its system's active list: power can come back on any tick.
   */
  NoPower: 9,
  /**
   * Shown, never stored: a `Working` electric consumer on a network whose
   * satisfaction is below 1 (it runs slower). The snapshot reports it in
   * place of `Working` (`displayStatus` in src/sim/snapshot.ts).
   */
  LowPower: 10,
  /** An assembling machine with no recipe set. */
  NoRecipe: 11,
} as const;

export type MachineState = (typeof MachineState)[keyof typeof MachineState];
