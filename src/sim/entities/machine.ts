/**
 * Machine states shared by every entity type that works on its own (furnaces,
 * mining drills and inserters now; assemblers later). See docs/ARCHITECTURE.md,
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
} as const;

export type MachineState = (typeof MachineState)[keyof typeof MachineState];
