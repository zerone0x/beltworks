/**
 * Wake subscriptions for machine sleep (docs/ARCHITECTURE.md, "Machine
 * sleep"): an entity that can't make progress (an inserter waiting on an
 * empty chest, say) subscribes to the entity it waits on and leaves its
 * system's active list. When the target changes, its table calls
 * `Entities.notify(target)`, which hands every subscriber to its own table's
 * `wake` hook, in subscription order.
 *
 * Subscriptions change what the systems do, so they are part of the state
 * hash.
 */

import { FNV1A32_OFFSET_BASIS, fnv1a32 } from '../hash';
import type { SaveReader, SaveWriter } from '../save/codec';

export class WakeSubscriptions {
  /** Watchers per target, in subscription order. */
  private readonly byTarget = new Map<number, number[]>();
  /** Targets per watcher, so a removed watcher can be dropped everywhere. */
  private readonly byWatcher = new Map<number, number[]>();

  /** Called with the target of every new subscription (`Entities` forwards it to the target's table). */
  onWatch: ((target: number) => void) | null = null;

  /** Number of (watcher, target) pairs. */
  get size(): number {
    let n = 0;
    for (const list of this.byTarget.values()) n += list.length;
    return n;
  }

  /** Subscribes `watcher` to changes of `target`. Subscribing twice is a no-op. */
  watch(watcher: number, target: number): void {
    const watchers = this.byTarget.get(target);
    if (watchers?.includes(watcher)) {
      return;
    }
    if (watchers) watchers.push(watcher);
    else this.byTarget.set(target, [watcher]);
    const targets = this.byWatcher.get(watcher);
    if (targets) targets.push(target);
    else this.byWatcher.set(watcher, [target]);
    this.onWatch?.(target);
  }

  /** Cancels one subscription. */
  unwatch(watcher: number, target: number): void {
    removeFrom(this.byTarget, target, watcher);
    removeFrom(this.byWatcher, watcher, target);
  }

  /** Whether anything is subscribed to `target`. */
  isWatched(target: number): boolean {
    return this.byTarget.has(target);
  }

  /** Whether `watcher`'s one and only subscription is to `target`. */
  watchesOnly(watcher: number, target: number): boolean {
    const targets = this.byWatcher.get(watcher);
    return targets?.length === 1 && targets[0] === target;
  }

  /**
   * Whether `watcher`'s subscriptions are exactly to `first` and `second`, in
   * either order (`load` rebuilds a watcher's list in the order of the saved
   * targets, not the order it subscribed in).
   */
  watchesExactly(watcher: number, first: number, second: number): boolean {
    const targets = this.byWatcher.get(watcher);
    return (
      targets?.length === 2 &&
      ((targets[0] === first && targets[1] === second) ||
        (targets[0] === second && targets[1] === first))
    );
  }

  /** The watchers of `target`, in subscription order (a copy). */
  watchersOf(target: number): number[] {
    return this.byTarget.get(target)?.slice() ?? [];
  }

  /**
   * {@link watchersOf} without the copy, for `Entities.notify`: the list
   * itself (`undefined` when nothing watches `target`), valid until the
   * subscriptions change.
   */
  watchersView(target: number): readonly number[] | undefined {
    return this.byTarget.get(target);
  }

  /** Drops every subscription of `watcher`. */
  unwatchAll(watcher: number): void {
    for (const target of this.byWatcher.get(watcher) ?? []) {
      removeFrom(this.byTarget, target, watcher);
    }
    this.byWatcher.delete(watcher);
  }

  /** Drops every subscription to `target` and returns the watchers it had. */
  forgetTarget(target: number): number[] {
    const watchers = this.byTarget.get(target) ?? [];
    this.byTarget.delete(target);
    for (const watcher of watchers) {
      removeFrom(this.byWatcher, watcher, target);
    }
    return watchers;
  }

  /** Folds the subscriptions (targets sorted by id) into a running FNV-1a hash. */
  hashInto(hash: number = FNV1A32_OFFSET_BASIS): number {
    const targets = Array.from(this.byTarget.keys()).sort((a, b) => a - b);
    let h = fnv1a32(Uint32Array.of(targets.length), hash);
    for (const target of targets) {
      const watchers = this.byTarget.get(target)!;
      h = fnv1a32(Uint32Array.of(target, watchers.length), h);
      h = fnv1a32(Uint32Array.from(watchers), h);
    }
    return h;
  }

  /** Saves every subscription: the watchers of each target, in subscription order. */
  save(w: SaveWriter): void {
    w.u32(this.byTarget.size);
    for (const [target, watchers] of this.byTarget) {
      w.u32(target);
      w.ids(watchers);
    }
  }

  /**
   * Restores what `save` wrote into these empty subscriptions, without
   * calling `onWatch` (the tables load their own lists of watched entities).
   */
  load(r: SaveReader): void {
    for (let i = r.u32(); i > 0; i--) {
      const target = r.u32();
      const watchers = r.ids();
      if (watchers.length === 0) continue;
      this.byTarget.set(target, watchers);
      for (const watcher of watchers) {
        const targets = this.byWatcher.get(watcher);
        if (targets) targets.push(target);
        else this.byWatcher.set(watcher, [target]);
      }
    }
  }
}

function removeFrom(map: Map<number, number[]>, key: number, value: number): void {
  const list = map.get(key);
  if (!list) return;
  const i = list.indexOf(value);
  if (i >= 0) list.splice(i, 1);
  if (list.length === 0) map.delete(key);
}
