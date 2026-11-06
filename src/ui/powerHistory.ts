/**
 * The power panel's history (main thread only, not simulation state): for
 * every electric network the snapshots mention, one sample per simulated
 * second of its demand, supply (the most its producers could deliver) and
 * load (what they delivered), averaged over the snapshots of that second,
 * for the last `HISTORY_SECONDS` seconds.
 *
 * Fed from every snapshot's power section (the networks of the poles around
 * the view) and from the open panel's network detail, so a panel opened on
 * a network that was in view already has a graph. Seconds are counted in
 * ticks (60 per second), so a slow worker stretches nothing; seconds with no
 * snapshot of a network (out of view) are simply missing.
 */

/** Ticks per simulated second. */
const TICKS_PER_SECOND = 60;
/** Seconds of history kept per network. */
export const HISTORY_SECONDS = 60;

/** One second of a network, in joules per tick (averages, so not integers). */
export interface PowerSample {
  /** The simulated second: `floor(tick / 60)`. */
  second: number;
  demand: number;
  supply: number;
  load: number;
}

/** A network's figures as of one snapshot (joules per tick). */
export interface NetworkFigures {
  id: number;
  demand: number;
  supply: number;
}

interface Track {
  samples: PowerSample[];
  /** The second being accumulated, and its sums over `n` snapshots. */
  second: number;
  n: number;
  demand: number;
  supply: number;
  load: number;
}

export class PowerHistory {
  private readonly tracks = new Map<number, Track>();
  /** The second of the latest snapshot recorded. */
  private now = -1;

  /** The second of the latest snapshot recorded (-1 before the first). */
  get second(): number {
    return this.now;
  }

  /**
   * Records the networks of the snapshot taken after tick `tick` (each id at
   * most once). When a network's second changes, the finished second becomes
   * a sample. Networks not seen for `HISTORY_SECONDS` are forgotten.
   */
  record(tick: number, networks: readonly NetworkFigures[]): void {
    const second = Math.floor(tick / TICKS_PER_SECOND);
    if (second < this.now) {
      // A new game: the clock went back.
      this.tracks.clear();
    }
    this.now = second;
    for (const { id, demand, supply } of networks) {
      let t = this.tracks.get(id);
      if (!t) {
        t = { samples: [], second, n: 0, demand: 0, supply: 0, load: 0 };
        this.tracks.set(id, t);
      }
      if (t.second !== second) {
        this.flush(t);
        t.second = second;
      }
      t.n++;
      t.demand += demand;
      t.supply += supply;
      t.load += Math.min(demand, supply);
    }
    const oldest = second - HISTORY_SECONDS;
    for (const [id, t] of this.tracks) {
      if (t.second < oldest) {
        this.tracks.delete(id);
        continue;
      }
      let drop = 0;
      while (drop < t.samples.length && t.samples[drop]!.second < oldest) drop++;
      if (drop > 0) t.samples.splice(0, drop);
    }
  }

  /** Network `net`'s finished seconds within the last `HISTORY_SECONDS`, oldest first. */
  samples(net: number): readonly PowerSample[] {
    return this.tracks.get(net)?.samples ?? [];
  }

  private flush(t: Track): void {
    if (t.n === 0) return;
    t.samples.push({
      second: t.second,
      demand: t.demand / t.n,
      supply: t.supply / t.n,
      load: t.load / t.n,
    });
    if (t.samples.length > HISTORY_SECONDS) t.samples.shift();
    t.n = 0;
    t.demand = t.supply = t.load = 0;
  }
}
