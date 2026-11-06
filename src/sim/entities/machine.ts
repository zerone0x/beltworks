/**
 * Machine states shared by every entity type that works on its own (furnaces
 * now; drills, inserters and assemblers later). See docs/ARCHITECTURE.md,
 * "Machine sleep": a machine that isn't `Working` leaves its system's active
 * list until something it waits on changes.
 *
 * Stored as a uint8 in entity tables and sent to the renderer in snapshots;
 * the values must stay stable. Types that need more states (a drill's
 * `Depleted`, say) add them here with new values.
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
} as const;

export type MachineState = (typeof MachineState)[keyof typeof MachineState];
