import { describe, expect, it } from 'vitest';
import { EntityTypeId, isBeltType } from '../../src/data/entities';
import { formatReport, percentiles, type ProfileReport } from '../../src/profile/renderProfile';
import { BeltLayer } from '../../src/render/beltLayer';
import { decodeBelts, decodeInserters, decodePower, ENTITY_STRIDE } from '../../src/sim/snapshot';
import { BENCH_SCENES, RenderScene, isRenderScene } from '../../src/worker/renderScene';
import { SCENES } from '../../tools/bench/scenes/index';

const ALL = { cx0: -100, cy0: -100, cx1: 100, cy1: 100 };

describe('grid render scene', () => {
  const scene = new RenderScene('grid-10k');

  it('is the M4 target scene: 10k entities and about 50k items on belts', () => {
    expect(scene.entities.length).toBeGreaterThanOrEqual(10_000);
    expect(scene.entities.length).toBeLessThan(10_500);
    expect(scene.items).toBeGreaterThanOrEqual(48_000);
    expect(isRenderScene('grid-10k')).toBe(true);
    // The benchmark scenes are built by the worker (tools/bench/scenes/).
    expect(isRenderScene('10k')).toBe(true);
    expect(isRenderScene('nope')).toBe(false);
    expect(() => new RenderScene('10k')).toThrow();
    expect(BENCH_SCENES).toEqual(SCENES.map((s) => s.name));
    expect(() => new RenderScene('nope')).toThrow();
  });

  it('encodes snapshot buffers the main thread decodes', () => {
    const entities = scene.encodeEntities(ALL, 100);
    expect(entities.length).toBe(scene.entities.length * ENTITY_STRIDE);
    const belts = decodeBelts(scene.encodeBelts(ALL, 100).buffer);
    expect(belts.length).toBe(scene.entities.filter((e) => isBeltType(e.type)).length);
    expect(belts.reduce((n, b) => n + b.items.length, 0)).toBe(scene.items);
    for (const b of belts.slice(0, 50)) {
      for (const it of b.items) {
        expect(it.offset).toBeGreaterThanOrEqual(0);
        expect(it.offset).toBeLessThan(256);
      }
    }
    const inserters = decodeInserters(scene.encodeInserters(ALL, 100).buffer);
    expect(inserters.length).toBeGreaterThan(1000);
    for (const ins of inserters) {
      expect(ins.arm).toBeGreaterThanOrEqual(0);
      expect(ins.arm).toBeLessThanOrEqual(ins.span);
    }
    const power = decodePower(scene.encodePower(ALL).buffer);
    expect(power.poles.length).toBe(
      scene.entities.filter((e) => e.type === EntityTypeId.SmallElectricPole).length,
    );
    expect(power.wires.length).toBeGreaterThan(power.poles.length / 2);
    expect(power.networks).toHaveLength(1);
  });

  it('sends only what lies in the chunk window, and moves with the tick', () => {
    const window = { cx0: 0, cy0: 0, cx1: 0, cy1: 0 };
    const entities = scene.encodeEntities(window, 0);
    for (let o = 0; o < entities.length; o += ENTITY_STRIDE) {
      expect(entities[o + 2]! >> 5).toBe(0);
      expect(entities[o + 3]! >> 5).toBe(0);
    }
    expect(entities.length).toBeGreaterThan(0);
    const a = decodeBelts(scene.encodeBelts(window, 0).buffer)[0]!;
    const b = decodeBelts(scene.encodeBelts(window, 1).buffer)[0]!;
    expect(b.items[0]!.offset).not.toBe(a.items[0]!.offset);
    expect(scene.encodeEntities(null, 0)).toHaveLength(0);
  });
});

describe('belt layer parsing', () => {
  it('reads the belts in draw order with every item, without decoding objects per frame', () => {
    const scene = new RenderScene('grid-1k');
    const buffer = scene.encodeBelts(ALL, 7).buffer;
    const layer = new BeltLayer();
    layer.apply(buffer.slice(0), 7, 0);
    expect(layer.itemCount).toBe(scene.items);
    const data = layer.data;
    expect(data).toHaveLength(decodeBelts(buffer).length);
    // North to south, then west to east.
    for (let i = 1; i < data.length; i++) {
      const [p, q] = [data[i - 1]!, data[i]!];
      expect(p.y < q.y || (p.y === q.y && p.x < q.x)).toBe(true);
    }
  });
});

describe('render profile report', () => {
  it('computes percentiles', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentiles(values)).toEqual({ p50: 51, p95: 96, p99: 100, max: 100, mean: 50.5 });
    expect(percentiles([])).toEqual({ p50: 0, p95: 0, p99: 0, max: 0, mean: 0 });
  });

  it('formats a Markdown table', () => {
    const p = { p50: 16.7, p95: 17, p99: 20, max: 33, mean: 16.9 };
    const report: ProfileReport = {
      renderer: 'Test GPU',
      software: false,
      width: 1280,
      height: 720,
      resolution: 1,
      terrain: 'rendered',
      maxTexels: 64,
      stages: [
        {
          name: 'factory 1x',
          zoom: 1,
          panning: false,
          frames: 180,
          fps: 59.9,
          interval: p,
          work: p,
          hitches: 0,
          bakes: 2,
          entities: 10,
          belts: 5,
          beltItems: 40,
        },
      ],
    };
    const text = formatReport(report);
    expect(text).toContain('Test GPU');
    expect(text).toContain('| factory 1x | 59.9 | 16.7 / 17.0 / 20.0 / 33.0 |');
  });
});
