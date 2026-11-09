import { describe, expect, it } from 'vitest';
import {
  AUTOSAVE_SLOTS,
  AUTOSAVE_TICKS,
  AutosaveClock,
  exportFileName,
  formatPlayTime,
  importedName,
  newSlotId,
  nextAutosaveSlot,
  sortSlots,
  type SaveSlot,
} from '../../src/save/slots';

const slot = (id: string, savedAt: number, autosave = id.startsWith('autosave')): SaveSlot => ({
  id,
  name: id,
  autosave,
  savedAt,
  tick: 0,
  entities: 0,
  bytes: 0,
  version: 1,
});

describe('save slots', () => {
  it('rotates through the autosave slots, filling free ones first, then the oldest', () => {
    expect(AUTOSAVE_SLOTS).toBe(3);
    expect(nextAutosaveSlot([])).toEqual({ id: 'autosave-1', name: 'Autosave 1' });
    expect(nextAutosaveSlot([slot('autosave-1', 5), slot('save-1', 1)]).id).toBe('autosave-2');
    const full = [slot('autosave-1', 30), slot('autosave-2', 10), slot('autosave-3', 20)];
    expect(nextAutosaveSlot(full).id).toBe('autosave-2');
  });

  it('lists the newest first', () => {
    const sorted = sortSlots([slot('a', 1), slot('b', 3), slot('c', 2)]);
    expect(sorted.map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('makes fresh ids for new saves', () => {
    expect(newSlotId(42, [])).toBe('save-42');
    expect(newSlotId(42, [slot('save-42', 0), slot('save-42-1', 0)])).toBe('save-42-2');
  });

  it('formats play time and file names', () => {
    expect(formatPlayTime(0)).toBe('0:00:00');
    expect(formatPlayTime(60 * (3600 + 2 * 60 + 5))).toBe('1:02:05');
    expect(exportFileName('My base: v2!')).toBe('beltworks-My-base-v2.bwsave');
    expect(exportFileName('???')).toBe('beltworks-save.bwsave');
    expect(importedName('beltworks-My-base.bwsave')).toBe('My-base');
  });

  it('counts autosave time in ticks of play, from the first tick it sees', () => {
    expect(AUTOSAVE_TICKS).toBe(5 * 60 * 60);
    // A loaded game starts counting at its save's tick.
    const clock = new AutosaveClock(600);
    expect(clock.due(10_000)).toBe(false);
    expect(clock.due(10_599)).toBe(false);
    // However long the menu paused the game, the next tick is only one later: still not due.
    expect(clock.due(10_599)).toBe(false);
    expect(clock.due(10_600)).toBe(true);
    // Due until an autosave restarts the count (e.g. it was skipped while the tab was hidden).
    expect(clock.due(10_700)).toBe(true);
    clock.restart(10_700);
    expect(clock.due(11_299)).toBe(false);
    expect(clock.due(11_300)).toBe(true);
    // A tick before the count's start (a different game) starts it again.
    expect(clock.due(5)).toBe(false);
    expect(clock.due(605)).toBe(true);
  });
});
