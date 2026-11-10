/**
 * The GPU demo's camera, film script and belt editing (#131,
 * demo/gpu/README.md): the camera's pixel and tile mappings, the film's
 * camera as a pure function of the tick, and the click rule that places and
 * rotates belts, with the reference step holding items at a dead end.
 * `gpuDemo.spec.ts` checks the GPU side of editing.
 */

import { describe, expect, it } from 'vitest';
import {
  FILM_ZOOM,
  cameraView,
  clampCamera,
  filmEditTile,
  filmEdits,
  filmShot,
  fitCamera,
  panBy,
  pixelToTile,
  splitterPoint,
  splitterSegment,
  tileToPixel,
  zoomAt,
  type Viewport,
} from '../../demo/gpu/camera';
import { EditableNetwork } from '../../demo/gpu/edit';
import { fitView } from '../../demo/gpu/gpu';
import {
  DIRS,
  NO_SEGMENT,
  SEGMENT_LENGTH,
  SEGMENT_WORDS,
  SegmentField as F,
  buildNetwork,
} from '../../demo/gpu/network';
import { initItems, referenceCounters, referenceRun } from '../../demo/gpu/sim';

const net = buildNetwork();
const vp: Viewport = { width: 1280, height: 720, top: 150 };

describe('camera', () => {
  it('draws the fit camera exactly as fitView', () => {
    const a = cameraView(net, fitCamera(net), vp);
    const b = fitView(net, vp.width, vp.height, vp.top);
    for (const k of ['scale', 'offset', 'half'] as const) {
      expect(a[k][0]).toBeCloseTo(b[k][0], 9);
      expect(a[k][1]).toBeCloseTo(b[k][1], 9);
    }
  });

  it('maps tiles to pixels and back', () => {
    const camera = { x: 10.25, y: 7.5, zoom: 3.5 };
    const [px, py] = tileToPixel(net, camera, vp, 12, 4);
    const [tx, ty] = pixelToTile(net, camera, vp, px, py);
    expect(tx).toBeCloseTo(12, 9);
    expect(ty).toBeCloseTo(4, 9);
    // The camera's center is at the center of the free area.
    const [cx, cy] = tileToPixel(net, camera, vp, camera.x, camera.y);
    expect([cx, cy]).toEqual([640, 150 + 285]);
  });

  it('zooms about the pointer and pans with it', () => {
    const start = fitCamera(net);
    const before = pixelToTile(net, start, vp, 300, 400);
    const zoomed = zoomAt(net, start, vp, 300, 400, 4);
    expect(zoomed.zoom).toBe(4);
    const after = pixelToTile(net, zoomed, vp, 300, 400);
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
    // Dragging the picture right by d pixels shows what was d pixels to the left under the pointer.
    const panned = panBy(net, zoomed, vp, 50, 0);
    const moved = pixelToTile(net, panned, vp, 350, 400);
    expect(moved[0]).toBeCloseTo(after[0], 9);
    expect(clampCamera(net, { x: -5, y: 999, zoom: 1000 })).toEqual({
      x: 0,
      y: net.height,
      zoom: 32,
    });
  });
});

describe('film', () => {
  const total = 1440;

  it('starts wide, zooms into the splitter, comes back out and ends on the end card', () => {
    const shots = Array.from({ length: total + 1 }, (_, t) => filmShot(net, t, total, '1M'));
    expect(shots[0]!.camera).toEqual(fitCamera(net));
    expect(shots[0]!.endCard).toBe(false);
    expect(shots[0]!.caption).toContain('1M items');
    expect(shots[total]!.endCard).toBe(true);
    expect(shots[total]!.camera).toEqual(fitCamera(net));
    const deepest = Math.max(...shots.map((s) => s.camera.zoom));
    expect(deepest).toBe(FILM_ZOOM);
    // While the camera is close, the splitter and the edited tile are in view.
    const [sx, sy] = splitterPoint(net);
    const [ex, ey] = filmEditTile(net);
    for (const shot of shots.filter((s) => s.camera.zoom === FILM_ZOOM)) {
      for (const [x, y] of [
        [sx, sy],
        [ex + 0.5, ey + 0.5],
      ] as const) {
        const [px, py] = tileToPixel(net, shot.camera, vp, x, y);
        expect(px).toBeGreaterThan(0);
        expect(px).toBeLessThan(vp.width);
        expect(py).toBeGreaterThan(vp.top);
        expect(py).toBeLessThan(vp.height);
      }
    }
    // The zoom changes smoothly: no jumps between ticks.
    for (let t = 1; t <= total; t++) {
      const ratio = shots[t]!.camera.zoom / shots[t - 1]!.camera.zoom;
      expect(Math.abs(Math.log(ratio))).toBeLessThan(0.02);
    }
    // The splitter stays in view on the way in, too.
    for (const shot of shots) {
      const [px, py] = tileToPixel(net, shot.camera, vp, sx, sy);
      expect(px).toBeGreaterThanOrEqual(0);
      expect(py).toBeGreaterThanOrEqual(vp.top - 1e-6);
    }
  });

  it('is a pure function of the tick', () => {
    expect(filmShot(net, 700, total, 'x')).toEqual(filmShot(net, 700, total, 'x'));
  });

  it('clicks one belt three times while close, which ends straight again', () => {
    const edits = filmEdits(net, total);
    expect(edits).toHaveLength(3);
    for (const e of edits) expect(filmShot(net, e.tick, total, '').camera.zoom).toBe(FILM_ZOOM);
    expect(filmShot(net, edits[0]!.tick, total, '').click).toEqual({
      x: edits[0]!.x,
      y: edits[0]!.y,
    });
    const edited = new EditableNetwork(net);
    for (const e of edits) expect(edited.edit(e.x, e.y).kind).toBe('rotated');
    expect(edited.segments).toEqual(net.segments);
  });
});

describe('belt editing', () => {
  const [ex, ey] = filmEditTile(net);

  it('rotates a belt straight, right, left and straight again, relinking it', () => {
    const edited = new EditableNetwork(net);
    const [s] = edited.segmentsAt(ex, ey);
    expect(edited.segmentsAt(ex, ey)).toHaveLength(1);
    const inDir = edited.get(s!, F.inDir);
    const before = edited.get(s!, F.next0);
    const outs: number[] = [];
    for (let k = 0; k < 3; k++) {
      const r = edited.edit(ex, ey);
      expect(r).toEqual({ kind: 'rotated', segment: s, changed: [s] });
      outs.push(edited.get(s!, F.outDir));
      if (k < 2) {
        // Nothing next to the film's tile across the belt: a dead end.
        expect(edited.get(s!, F.next0)).toBe(NO_SEGMENT);
        expect(edited.get(s!, F.next1)).toBe(NO_SEGMENT);
      }
    }
    expect(outs).toEqual([(inDir + 1) % 4, (inDir + 3) % 4, inDir]);
    expect(edited.get(s!, F.next0)).toBe(before);
    expect(edited.count).toBe(net.count);
  });

  it('places a belt that continues a dead end, and links it on', () => {
    const edited = new EditableNetwork(net);
    const [s] = edited.segmentsAt(ex, ey);
    edited.edit(ex, ey); // a right turn into an empty tile
    const out = edited.get(s!, F.outDir);
    const [dx, dy] = DIRS[out]!;
    expect(edited.segmentsAt(ex + dx, ey + dy)).toEqual([]);
    const r = edited.edit(ex + dx, ey + dy);
    expect(r.kind).toBe('placed');
    if (r.kind !== 'placed') return;
    expect(r.segment).toBe(net.count);
    expect(r.changed).toEqual([net.count, s]);
    expect(edited.count).toBe(net.count + 1);
    expect(edited.get(s!, F.next0)).toBe(r.segment);
    expect(edited.get(r.segment, F.inDir)).toBe(out);
    expect(edited.get(r.segment, F.outDir)).toBe(out);
    expect(edited.get(r.segment, F.speed)).toBe(edited.get(s!, F.speed));
    expect(edited.get(r.segment, F.group)).toBe(edited.get(s!, F.group));
    // The placed belt leads on into whatever is there: here the serpentine's row, else nothing.
    const next = edited.get(r.segment, F.next0);
    if (next !== NO_SEGMENT) expect(edited.get(next, F.inDir)).toBe(out);
    // Clicking it again rotates it.
    expect(edited.edit(ex + dx, ey + dy).kind).toBe('rotated');
    expect(edited.segments.length).toBe(edited.count * SEGMENT_WORDS);
  });

  it('refuses the splitter, two-belt tiles and tiles off the grid', () => {
    const edited = new EditableNetwork(net);
    const s = splitterSegment(net);
    const x = edited.get(s, F.x);
    const y = edited.get(s, F.y);
    expect(edited.edit(x, y)).toMatchObject({ kind: 'refused', reason: 'the splitter' });
    const [dx, dy] = DIRS[edited.get(s, F.outDir)]!;
    expect(edited.edit(x + dx, y + dy)).toMatchObject({ kind: 'refused' });
    expect(edited.edit(-1, 0)).toMatchObject({ kind: 'refused', reason: 'outside the grid' });
    expect(edited.edit(net.width, 0)).toMatchObject({ kind: 'refused' });
    expect(edited.segments).toEqual(net.segments);
  });

  it('runs out of slots instead of growing past its capacity', () => {
    const edited = new EditableNetwork(net, 1);
    expect(edited.edit(0, 0).kind).toBe('placed');
    expect(edited.edit(net.width - 1, 0)).toMatchObject({ kind: 'refused' });
  });

  it('holds items at the end of a dead end, and lets them on when it is relinked', () => {
    const items = initItems(20_000, net);
    const edited = new EditableNetwork(net);
    const [s] = edited.segmentsAt(ex, ey);
    edited.edit(ex, ey);
    const held = referenceRun(items, edited, 600);
    let waiting = 0;
    for (let i = 0; i < held.belt.length; i++) {
      if (held.belt[i] === s) {
        // Items only ever wait at the very end of the dead end, or are still on their way to it.
        if (held.progress[i] === SEGMENT_LENGTH - 1) waiting++;
        expect(held.progress[i]).toBeLessThan(SEGMENT_LENGTH);
      }
    }
    expect(waiting).toBeGreaterThan(100);
    // Nothing is lost.
    const counters = referenceCounters(held, edited);
    expect(counters[0]! + counters[1]! + counters[2]!).toBe(20_000);
    // Rotate back to straight (two more clicks) and the queue drains.
    edited.edit(ex, ey);
    edited.edit(ex, ey);
    const drained = referenceRun(held, edited, 120, 600);
    let still = 0;
    for (let i = 0; i < drained.belt.length; i++) {
      if (drained.belt[i] === s && drained.progress[i] === SEGMENT_LENGTH - 1) still++;
    }
    expect(still).toBeLessThan(waiting / 10);
  });
});
