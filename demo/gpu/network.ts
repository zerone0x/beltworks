/**
 * The demo's looping belt network: a few hundred one-tile segments (straight
 * runs and corners) in three paths. The trunk ends on a splitter that feeds two
 * branches, and both branches merge back into the trunk's first tile.
 *
 * A segment is one tile an item crosses in a fixed direction. A tile where the
 * path turns is a corner segment (its entry and exit directions differ). The
 * splitter and the merge are tiles that hold two segments: one per branch.
 *
 * The network is plain data, one `Uint32Array` of `SEGMENT_WORDS` words per
 * segment, uploaded unchanged to a GPU storage buffer (see `Segment` in
 * `shaders.ts`).
 */

/** Words per segment in `Network.segments`. */
export const SEGMENT_WORDS = 8;

/** The word offsets of a segment's fields. */
export const SegmentField = {
  /** Tile column. */
  x: 0,
  /** Tile row. */
  y: 1,
  /** Direction of travel when the item enters the tile (`DIRS`). */
  inDir: 2,
  /** Direction of travel when the item leaves the tile. */
  outDir: 3,
  /** The segment an item goes to when it leaves this one. */
  next0: 4,
  /** The alternative successor: differs from `next0` only on a splitter's input. */
  next1: 5,
  /** Progress units added per tick (`SEGMENT_LENGTH` is one tile). */
  speed: 6,
  /** Which path the segment belongs to (`Group`). */
  group: 7,
} as const;

/**
 * A successor that is no segment: the belt is a dead end, and items wait at
 * its end. The built network has none; belt editing (`edit.ts`) can make them.
 */
export const NO_SEGMENT = 0xffffffff;

/** Directions of travel: east, south, west, north (y grows downward). */
export const DIRS: readonly (readonly [number, number])[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/** The paths of the network, stored in each segment's `group` field. */
export const Group = { trunk: 0, branchA: 1, branchB: 2 } as const;
export const GROUP_COUNT = 3;

/** Progress units in one segment (one tile): 16.16 fixed point. */
export const SEGMENT_LENGTH = 1 << 16;

/**
 * Belt speeds in progress units per tick, the three belt tiers of the game
 * at 60 ticks per second: 1.875, 3.75 and 5.625 tiles per second. Every speed is
 * below `SEGMENT_LENGTH`, so an item crosses at most one tile boundary a tick.
 */
export const SPEED = { slow: 2048, fast: 4096, express: 6144 } as const;

export interface Network {
  /** `count * SEGMENT_WORDS` words, see `SegmentField`. */
  readonly segments: Uint32Array;
  readonly count: number;
  /** The grid the network fits in, in tiles: the network and a one-tile border. */
  readonly width: number;
  readonly height: number;
}

type Tile = readonly [number, number];

function dirBetween(a: Tile, b: Tile): number {
  const dx = Math.sign(b[0] - a[0]);
  const dy = Math.sign(b[1] - a[1]);
  const d = DIRS.findIndex(([x, y]) => x === dx && y === dy);
  if (d < 0 || Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) !== 1) {
    throw new Error(`tiles ${a.join(',')} and ${b.join(',')} are not neighbors`);
  }
  return d;
}

/** The tiles of an axis-aligned polyline through `waypoints`, both ends included. */
function expand(waypoints: readonly Tile[]): Tile[] {
  const tiles: Tile[] = [waypoints[0]!];
  for (let k = 1; k < waypoints.length; k++) {
    const [x0, y0] = tiles[tiles.length - 1]!;
    const [x1, y1] = waypoints[k]!;
    if (x0 !== x1 && y0 !== y1) throw new Error('waypoints must be axis aligned');
    const n = Math.abs(x1 - x0) + Math.abs(y1 - y0);
    const sx = Math.sign(x1 - x0);
    const sy = Math.sign(y1 - y0);
    for (let s = 1; s <= n; s++) tiles.push([x0 + sx * s, y0 + sy * s]);
  }
  return tiles;
}

interface Path {
  readonly tiles: Tile[];
  /** Direction of travel into the first tile. */
  readonly entry: number;
  /** Direction of travel out of the last tile. */
  readonly exit: number;
  readonly speed: number;
  readonly group: number;
}

/**
 * Builds the demo network, laid out on a `width` x `height` grid (at least 40 x 24).
 *
 * - trunk: up the left edge, then east into the splitter (express belts);
 * - branch A: the splitter's straight output, round the outside of the grid
 *   and into the merge from the south (fast belts);
 * - branch B: the splitter's turning output, a serpentine through the middle
 *   and into the merge from the east (slow belts).
 */
export function buildNetwork(width = 56, height = 32): Network {
  if (width < 40 || height < 24) throw new Error('the network needs at least 40 x 24 tiles');
  const mergeY = height - 6;
  const bottom = height - 3;
  const right = width - 3;
  const rowEast = width - 6;
  const rowWest = 6;

  // Branch B's serpentine: rows 3 tiles apart, an even number of them so the last heads west.
  const rows: number[] = [];
  for (let y = 7; y <= mergeY - 2; y += 3) rows.push(y);
  if (rows.length % 2 === 1) rows.pop();
  const serpentine: Tile[] = [
    [4, 4],
    [4, rows[0]!],
  ];
  rows.forEach((y, k) => {
    if (k > 0) serpentine.push([k % 2 === 1 ? rowEast : rowWest, y]);
    serpentine.push([k % 2 === 0 ? rowEast : rowWest, y]);
  });
  serpentine.push([rowWest, mergeY], [2, mergeY]);

  const N = 3;
  const E = 0;
  const paths: Path[] = [
    {
      tiles: expand([
        [2, mergeY - 1],
        [2, 4],
        [3, 4],
      ]),
      entry: N,
      exit: E,
      speed: SPEED.express,
      group: Group.trunk,
    },
    {
      tiles: expand([
        [4, 4],
        [right, 4],
        [right, bottom],
        [2, bottom],
        [2, mergeY],
      ]),
      entry: E,
      exit: N,
      speed: SPEED.fast,
      group: Group.branchA,
    },
    { tiles: expand(serpentine), entry: E, exit: N, speed: SPEED.slow, group: Group.branchB },
  ];

  const starts: number[] = [];
  let count = 0;
  for (const p of paths) {
    starts.push(count);
    count += p.tiles.length;
  }
  const [trunk, branchA, branchB] = [0, 1, 2].map((k) => ({
    first: starts[k]!,
    last: starts[k]! + paths[k]!.tiles.length - 1,
  })) as [Span, Span, Span];

  const segments = new Uint32Array(count * SEGMENT_WORDS);
  paths.forEach((p, k) => {
    p.tiles.forEach((tile, t) => {
      const o = (starts[k]! + t) * SEGMENT_WORDS;
      const prev = p.tiles[t - 1];
      const next = p.tiles[t + 1];
      segments[o + SegmentField.x] = tile[0];
      segments[o + SegmentField.y] = tile[1];
      segments[o + SegmentField.inDir] = prev ? dirBetween(prev, tile) : p.entry;
      segments[o + SegmentField.outDir] = next ? dirBetween(tile, next) : p.exit;
      segments[o + SegmentField.next0] = starts[k]! + t + 1;
      segments[o + SegmentField.next1] = starts[k]! + t + 1;
      segments[o + SegmentField.speed] = p.speed;
      segments[o + SegmentField.group] = p.group;
    });
  });
  const link = (from: number, to0: number, to1 = to0): void => {
    segments[from * SEGMENT_WORDS + SegmentField.next0] = to0;
    segments[from * SEGMENT_WORDS + SegmentField.next1] = to1;
  };
  link(trunk.last, branchA.first, branchB.first); // the splitter
  link(branchA.last, trunk.first); // the merge
  link(branchB.last, trunk.first);

  // Trim the grid to the network plus a one-tile border, so the view shows no empty rows.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = 0;
  let maxY = 0;
  for (let o = 0; o < segments.length; o += SEGMENT_WORDS) {
    minX = Math.min(minX, segments[o + SegmentField.x]!);
    minY = Math.min(minY, segments[o + SegmentField.y]!);
    maxX = Math.max(maxX, segments[o + SegmentField.x]!);
    maxY = Math.max(maxY, segments[o + SegmentField.y]!);
  }
  for (let o = 0; o < segments.length; o += SEGMENT_WORDS) {
    segments[o + SegmentField.x]! -= minX - 1;
    segments[o + SegmentField.y]! -= minY - 1;
  }
  return { segments, count, width: maxX - minX + 3, height: maxY - minY + 3 };
}

interface Span {
  first: number;
  last: number;
}

/** One field of segment `s`. */
export function field(net: Network, s: number, f: number): number {
  return net.segments[s * SEGMENT_WORDS + f]!;
}
