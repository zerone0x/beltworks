/**
 * The simulation loop: `Sim.step()` advances exactly one tick, running the
 * systems in the fixed order from docs/ARCHITECTURE.md. Systems that don't
 * exist yet are no-op stubs so the order is pinned down (and tested) now.
 *
 * The simulation has no clock: the worker decides when to call `step()`.
 */

import { CommandQueue, validateCommand, type Command } from './commands';
import { placeEntity, removeEntity, rotateEntity } from './entities/build';
import { furnaceTable } from './entities/furnace';
import { insertIntoEntity, takeFromEntity } from './entities/transfer';
import { updatePlayers } from './player';
import { createSimState, hashState, type SimOptions, type SimState } from './state';

export interface System {
  readonly name: string;
  run(sim: Sim, commands: readonly Command[]): void;
}

const stub = (name: string): System => ({ name, run: () => {} });

/** Per-tick update order. Changing it changes the state hash. */
export const SYSTEMS: readonly System[] = [
  { name: 'commands', run: (sim, commands) => commands.forEach((c) => applyCommand(sim.state, c)) },
  stub('power'),
  stub('drills'),
  stub('belts'),
  stub('inserters'),
  { name: 'machines', run: (sim) => furnaceTable(sim.state.entities)?.update(sim.state.entities) },
  { name: 'players', run: (sim) => updatePlayers(sim.state.players, sim.state.world) },
  // Snapshots are read by the worker after `step()` returns; events will be emitted here.
  stub('events'),
];

/**
 * Applies one command. Commands for unknown players, and build and transfer
 * commands that don't apply (see src/sim/entities/build.ts and transfer.ts),
 * are ignored.
 */
export function applyCommand(state: SimState, cmd: Command): void {
  const { players } = state;
  if (!players.has(cmd.playerId)) {
    return;
  }
  switch (cmd.type) {
    case 'Move':
      players.setMove(cmd.playerId, cmd.dx, cmd.dy);
      break;
    case 'MineStart':
      players.startMining(cmd.playerId, cmd.x, cmd.y);
      break;
    case 'MineStop':
      players.stopMining(cmd.playerId);
      break;
    case 'Place':
      placeEntity(state, cmd.playerId, cmd.item, cmd.x, cmd.y, cmd.dir);
      break;
    case 'Remove':
      removeEntity(state, cmd.playerId, cmd.x, cmd.y);
      break;
    case 'Rotate':
      rotateEntity(state, cmd.playerId, cmd.x, cmd.y);
      break;
    case 'Insert':
      insertIntoEntity(state, cmd.playerId, cmd.entity, cmd.item, cmd.count);
      break;
    case 'Take':
      takeFromEntity(state, cmd.playerId, cmd.entity, cmd.slot, cmd.count);
      break;
  }
}

export class Sim {
  readonly state: SimState;
  private readonly queue = new CommandQueue();

  constructor(options: SimOptions) {
    this.state = createSimState(options);
  }

  /** Number of ticks completed; also the tick the next `step()` will run. */
  get tick(): number {
    return this.state.tick;
  }

  /** Number of commands waiting for a future tick. */
  get pendingCommands(): number {
    return this.queue.size;
  }

  /**
   * Queues a command for `cmd.tick`. Throws if the command is malformed or
   * its tick has already run (a late command would make runs diverge).
   */
  enqueue(cmd: Command): void {
    const error = validateCommand(cmd);
    if (error !== null) {
      throw new TypeError(`Invalid command: ${error}`);
    }
    if (cmd.tick < this.state.tick) {
      throw new RangeError(
        `Command for tick ${String(cmd.tick)} arrived after it ran (now at ${String(this.state.tick)})`,
      );
    }
    this.queue.push(cmd);
  }

  /** Advances exactly one tick. */
  step(): void {
    const commands = this.queue.takeUpTo(this.state.tick);
    for (const system of SYSTEMS) {
      system.run(this, commands);
    }
    this.state.tick++;
  }

  /** Hash of the complete simulation state (queued future commands are input, not state). */
  hash(): number {
    return hashState(this.state);
  }
}
