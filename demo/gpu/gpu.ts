/**
 * The GPU side of the demo: item state in ping-pong storage buffers, the step
 * and count compute passes, and the render passes that draw belts and items
 * from those same buffers. After the one upload of the initial state, no item
 * data crosses between CPU and GPU; only the aggregate counters are read back
 * (`readItems` is a full readback for the tests, on small item counts).
 */

import { SEGMENT_WORDS, type Network } from './network';
import { COUNTER_WORDS, type Items } from './sim';
import {
  STEP_UNIFORM_STRIDE,
  WORKGROUP_SIZE,
  beltShader,
  countShader,
  itemShader,
  stepShader,
} from './shaders';

// The WebGPU flag constants (globals in browsers, not declared in TypeScript's DOM lib).
const BUFFER = {
  MAP_READ: 0x0001,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  QUERY_RESOLVE: 0x0200,
} as const;
const STAGE = { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 } as const;
/** `GPUMapMode.READ`. */
const MAP_MODE_READ = 0x0001;

/** Steps encoded per submission: one uniform slot each. */
export const MAX_BATCH = 64;

/** Item quads per instance of the item draw, see `itemShader`. */
export const DEFAULT_QUADS_PER_INSTANCE = 64;

/**
 * How long a timed `step` took per tick. `gpu timestamps` comes from
 * timestamp queries around the step passes (the device has the
 * `timestamp-query` feature); `wall clock` is the time from the submission
 * until the GPU reported the work done, so it also counts submission
 * overhead and any work already queued before it.
 */
export interface StepTiming {
  readonly steps: number;
  readonly msPerStep: number;
  readonly source: 'gpu timestamps' | 'wall clock';
}

/** Bytes per item in each of the five item buffers (two belt, two progress, one type). */
const ITEM_BYTES = 4;

/**
 * The most items a device can hold: every item buffer must fit one storage
 * binding and one buffer, and the one-dimensional dispatch caps the
 * workgroup count.
 */
export function maxItems(limits: GPUSupportedLimits): number {
  return Math.min(
    Math.floor(limits.maxStorageBufferBindingSize / ITEM_BYTES),
    Math.floor(limits.maxBufferSize / ITEM_BYTES),
    limits.maxComputeWorkgroupsPerDimension * WORKGROUP_SIZE,
  );
}

/** Tile-to-clip-space transform and item size for the render passes (see `View` in shaders.ts). */
export interface ViewTransform {
  readonly scale: readonly [number, number];
  readonly offset: readonly [number, number];
  readonly half: readonly [number, number];
}

/**
 * Fits the network's grid into a `width` x `height` pixel target, centered in
 * the part below the first `top` pixels (kept clear for the overlay).
 */
export function fitView(net: Network, width: number, height: number, top = 0): ViewTransform {
  const free = Math.max(1, height - top);
  const tile = Math.min(width / net.width, free / net.height);
  const ox = (width - net.width * tile) / 2;
  const oy = top + (free - net.height * tile) / 2;
  // Items are a twelfth of a tile, and never smaller than 1.5 pixels.
  const halfPx = Math.max(0.75, tile / 24);
  return {
    scale: [(2 * tile) / width, (-2 * tile) / height],
    offset: [(2 * ox) / width - 1, 1 - (2 * oy) / height],
    half: [(2 * halfPx) / width, (2 * halfPx) / height],
  };
}

function storageEntry(
  binding: number,
  visibility: number,
  readOnly: boolean,
): GPUBindGroupLayoutEntry {
  return { binding, visibility, buffer: { type: readOnly ? 'read-only-storage' : 'storage' } };
}

export class GpuBeltSim {
  /** Ticks stepped so far: the next step steps this tick. */
  tick = 0;
  readonly items: number;

  private readonly device: GPUDevice;
  private readonly segmentBuffer: GPUBuffer;
  /** `[0]` and `[1]`: the ping-pong pair. */
  private readonly belt: [GPUBuffer, GPUBuffer];
  private readonly progress: [GPUBuffer, GPUBuffer];
  private readonly itemType: GPUBuffer;
  private readonly stepUniforms: GPUBuffer;
  private readonly viewUniform: GPUBuffer;
  private readonly counters: GPUBuffer;
  private readonly countersRead: GPUBuffer;
  private countersPending = false;
  /** Timestamp queries around a timed step, when the device has `timestamp-query`. */
  private readonly timestamps: {
    readonly set: GPUQuerySet;
    readonly resolve: GPUBuffer;
    readonly read: GPUBuffer;
    pending: boolean;
  } | null;
  /** Which buffer of each pair holds the current state. */
  private current = 0;

  private readonly stepPipeline: GPUComputePipeline;
  private readonly countPipeline: GPUComputePipeline;
  private readonly beltPipeline: GPURenderPipeline;
  private readonly itemPipeline: GPURenderPipeline;
  /** `[k]`: reads buffer k, writes buffer 1 - k. */
  private readonly stepGroups: [GPUBindGroup, GPUBindGroup];
  /** `[k]`: reads buffer k. */
  private readonly countGroups: [GPUBindGroup, GPUBindGroup];
  private readonly itemGroups: [GPUBindGroup, GPUBindGroup];
  private readonly beltGroup: GPUBindGroup;
  private segmentCount: number;
  private readonly quadsPerInstance: number;
  private readonly segmentCapacity: number;

  /**
   * `quadsPerInstance`: how many items' quads each instance of the item draw
   * covers (`QUADS` in shaders.ts); 1 is one quad per instance.
   * `segmentCapacity`: segment slots in the GPU's segment buffer, at least
   * `net.count`; the slots past it are for placed belts (`updateSegments`).
   */
  constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    net: Network,
    initial: Items,
    quadsPerInstance = DEFAULT_QUADS_PER_INSTANCE,
    segmentCapacity = net.count,
  ) {
    this.device = device;
    this.items = initial.belt.length;
    this.segmentCount = net.count;
    const n = this.items;

    const buffer = (label: string, size: number, usage: number): GPUBuffer =>
      device.createBuffer({ label, size: Math.max(16, size), usage });
    const upload = (label: string, data: Uint32Array, usage: number): GPUBuffer => {
      const b = buffer(label, data.byteLength, usage | BUFFER.COPY_DST);
      device.queue.writeBuffer(b, 0, data);
      return b;
    };
    const itemUsage = BUFFER.STORAGE | BUFFER.COPY_SRC;
    this.segmentCapacity = Math.max(segmentCapacity, net.count);
    this.segmentBuffer = buffer(
      'segments',
      this.segmentCapacity * SEGMENT_WORDS * 4,
      BUFFER.STORAGE | BUFFER.COPY_SRC | BUFFER.COPY_DST,
    );
    device.queue.writeBuffer(this.segmentBuffer, 0, net.segments);
    this.belt = [
      upload('belt 0', initial.belt, itemUsage),
      buffer('belt 1', n * ITEM_BYTES, itemUsage),
    ];
    this.progress = [
      upload('progress 0', initial.progress, itemUsage),
      buffer('progress 1', n * ITEM_BYTES, itemUsage),
    ];
    this.itemType = upload('item type', initial.itemType, itemUsage);
    this.stepUniforms = buffer(
      'step uniforms',
      MAX_BATCH * STEP_UNIFORM_STRIDE,
      BUFFER.UNIFORM | BUFFER.COPY_DST,
    );
    this.viewUniform = buffer('view', 32, BUFFER.UNIFORM | BUFFER.COPY_DST);
    this.counters = buffer(
      'counters',
      COUNTER_WORDS * 4,
      BUFFER.STORAGE | BUFFER.COPY_SRC | BUFFER.COPY_DST,
    );
    this.countersRead = buffer(
      'counters read',
      COUNTER_WORDS * 4,
      BUFFER.MAP_READ | BUFFER.COPY_DST,
    );

    this.timestamps = device.features.has('timestamp-query')
      ? {
          set: device.createQuerySet({ label: 'step timestamps', type: 'timestamp', count: 2 }),
          resolve: buffer('timestamps', 16, BUFFER.QUERY_RESOLVE | BUFFER.COPY_SRC),
          read: buffer('timestamps read', 16, BUFFER.MAP_READ | BUFFER.COPY_DST),
          pending: false,
        }
      : null;

    const C = STAGE.COMPUTE;
    const V = STAGE.VERTEX;
    const stepLayout = device.createBindGroupLayout({
      label: 'step',
      entries: [
        {
          binding: 0,
          visibility: C,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 },
        },
        storageEntry(1, C, true),
        storageEntry(2, C, true),
        storageEntry(3, C, true),
        storageEntry(4, C, false),
        storageEntry(5, C, false),
      ],
    });
    const countLayout = device.createBindGroupLayout({
      label: 'count',
      entries: [
        storageEntry(0, C, true),
        storageEntry(1, C, true),
        storageEntry(2, C, true),
        storageEntry(3, C, true),
        storageEntry(4, C, false),
      ],
    });
    const viewEntry: GPUBindGroupLayoutEntry = {
      binding: 0,
      visibility: V,
      buffer: { type: 'uniform' },
    };
    const beltLayout = device.createBindGroupLayout({
      label: 'belts',
      entries: [viewEntry, storageEntry(1, V, true)],
    });
    const itemLayout = device.createBindGroupLayout({
      label: 'items',
      entries: [
        viewEntry,
        storageEntry(1, V, true),
        storageEntry(2, V, true),
        storageEntry(3, V, true),
        storageEntry(4, V, true),
      ],
    });

    const constants = { ITEMS: n };
    this.stepPipeline = device.createComputePipeline({
      label: 'step',
      layout: device.createPipelineLayout({ bindGroupLayouts: [stepLayout] }),
      compute: {
        module: device.createShaderModule({ code: stepShader }),
        entryPoint: 'step',
        constants,
      },
    });
    this.countPipeline = device.createComputePipeline({
      label: 'count',
      layout: device.createPipelineLayout({ bindGroupLayouts: [countLayout] }),
      compute: {
        module: device.createShaderModule({ code: countShader }),
        entryPoint: 'count',
        constants,
      },
    });
    const renderPipeline = (
      label: string,
      code: string,
      layout: GPUBindGroupLayout,
      topology: GPUPrimitiveTopology,
      vertexConstants: Record<string, number> = {},
    ) => {
      const module = device.createShaderModule({ label, code });
      return device.createRenderPipeline({
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vertexMain', constants: vertexConstants },
        fragment: { module, entryPoint: 'fragmentMain', targets: [{ format }] },
        primitive: { topology },
      });
    };
    this.beltPipeline = renderPipeline('belts', beltShader, beltLayout, 'triangle-strip');
    this.itemPipeline = renderPipeline('items', itemShader, itemLayout, 'triangle-list', {
      ITEMS: n,
      QUADS: quadsPerInstance,
    });
    this.quadsPerInstance = quadsPerInstance;

    const bind = (layout: GPUBindGroupLayout, buffers: GPUBuffer[], dynamicSize?: number) =>
      device.createBindGroup({
        layout,
        entries: buffers.map((b, binding) =>
          binding === 0 && dynamicSize !== undefined
            ? { binding, resource: { buffer: b, size: dynamicSize } }
            : { binding, resource: { buffer: b } },
        ),
      });
    const pair = <T>(f: (k: 0 | 1) => T): [T, T] => [f(0), f(1)];
    this.stepGroups = pair((k) =>
      bind(
        stepLayout,
        [
          this.stepUniforms,
          this.segmentBuffer,
          this.belt[k],
          this.progress[k],
          this.belt[1 - k]!,
          this.progress[1 - k]!,
        ],
        16,
      ),
    );
    this.countGroups = pair((k) =>
      bind(countLayout, [
        this.segmentBuffer,
        this.belt[k],
        this.progress[k],
        this.itemType,
        this.counters,
      ]),
    );
    this.itemGroups = pair((k) =>
      bind(itemLayout, [
        this.viewUniform,
        this.segmentBuffer,
        this.belt[k],
        this.progress[k],
        this.itemType,
      ]),
    );
    this.beltGroup = bind(beltLayout, [this.viewUniform, this.segmentBuffer]);
  }

  private get workgroups(): number {
    return Math.ceil(this.items / WORKGROUP_SIZE);
  }

  /** Whether timed steps use GPU timestamp queries (else the wall clock). */
  get hasTimestamps(): boolean {
    return this.timestamps !== null;
  }

  /**
   * Steps `steps` ticks on the GPU, in batches of `MAX_BATCH` per submission.
   * With `timed`, the promise resolves with how long the steps took once the
   * GPU has done them (`StepTiming`); otherwise, or while an earlier timed
   * step's timestamps are still being read, it resolves with `null` at once.
   * It never rejects.
   */
  step(steps: number, timed = false): Promise<StepTiming | null> {
    const ts = timed && this.timestamps && !this.timestamps.pending ? this.timestamps : null;
    const start = performance.now();
    let pass = 0;
    for (let done = 0; done < steps;) {
      const batch = Math.min(MAX_BATCH, steps - done);
      const words = new Uint32Array((batch * STEP_UNIFORM_STRIDE) / 4);
      for (let k = 0; k < batch; k++) words[(k * STEP_UNIFORM_STRIDE) / 4] = this.tick + k;
      this.device.queue.writeBuffer(this.stepUniforms, 0, words);
      const encoder = this.device.createCommandEncoder({ label: 'step' });
      for (let k = 0; k < batch; k++, pass++) {
        // The first pass of the call writes the start timestamp and the last one the end.
        const first = pass === 0;
        const last = pass === steps - 1;
        // One pass per tick: a pass boundary orders the storage writes before the next read.
        const computePass = encoder.beginComputePass(
          ts && (first || last)
            ? {
                timestampWrites: {
                  querySet: ts.set,
                  ...(first && { beginningOfPassWriteIndex: 0 }),
                  ...(last && { endOfPassWriteIndex: 1 }),
                },
              }
            : {},
        );
        computePass.setPipeline(this.stepPipeline);
        computePass.setBindGroup(0, this.stepGroups[this.current as 0 | 1], [
          k * STEP_UNIFORM_STRIDE,
        ]);
        computePass.dispatchWorkgroups(this.workgroups);
        computePass.end();
        this.current = 1 - this.current;
      }
      if (ts && done + batch === steps) {
        encoder.resolveQuerySet(ts.set, 0, 2, ts.resolve, 0);
        encoder.copyBufferToBuffer(ts.resolve, 0, ts.read, 0, 16);
      }
      this.device.queue.submit([encoder.finish()]);
      this.tick += batch;
      done += batch;
    }
    if (!timed || steps === 0) return Promise.resolve(null);
    if (ts) {
      ts.pending = true;
      return ts.read.mapAsync(MAP_MODE_READ).then(
        () => {
          const [begin, end] = new BigUint64Array(ts.read.getMappedRange().slice(0));
          ts.read.unmap();
          ts.pending = false;
          const ns = Number(end! - begin!);
          return { steps, msPerStep: ns / 1e6 / steps, source: 'gpu timestamps' } as const;
        },
        () => {
          ts.pending = false;
          return null;
        },
      );
    }
    if (timed && this.timestamps) return Promise.resolve(null);
    return this.device.queue.onSubmittedWorkDone().then(
      () =>
        ({ steps, msPerStep: (performance.now() - start) / steps, source: 'wall clock' }) as const,
      () => null,
    );
  }

  /**
   * Writes segments `changed` of `net` into the GPU's segment buffer and
   * draws `net.count` belts from now on (belt editing, edit.ts). The writes
   * are queued between the step submissions before and after them, so the
   * item buffers and the tick carry on: nothing is restarted.
   */
  updateSegments(net: Network, changed: readonly number[]): void {
    if (net.count > this.segmentCapacity) throw new Error('more segments than the buffer holds');
    for (const s of changed) {
      if (s < 0 || s >= net.count) throw new Error(`no segment ${String(s)}`);
      this.device.queue.writeBuffer(
        this.segmentBuffer,
        s * SEGMENT_WORDS * 4,
        net.segments,
        s * SEGMENT_WORDS,
        SEGMENT_WORDS,
      );
    }
    this.segmentCount = net.count;
  }

  /** Reads the segment buffer back (`segmentCount` segments): the tests compare it to the CPU copy. */
  async readSegments(): Promise<Uint32Array> {
    const bytes = this.segmentCount * SEGMENT_WORDS * 4;
    const dst = this.device.createBuffer({
      size: Math.max(16, bytes),
      usage: BUFFER.MAP_READ | BUFFER.COPY_DST,
    });
    const encoder = this.device.createCommandEncoder({ label: 'read segments' });
    encoder.copyBufferToBuffer(this.segmentBuffer, 0, dst, 0, bytes);
    this.device.queue.submit([encoder.finish()]);
    await dst.mapAsync(MAP_MODE_READ);
    const data = new Uint32Array(dst.getMappedRange(0, bytes).slice(0));
    dst.destroy();
    return data;
  }

  /** Draws the belts and then every item into `target`. */
  render(target: GPUTextureView, view: ViewTransform): void {
    this.device.queue.writeBuffer(
      this.viewUniform,
      0,
      new Float32Array([...view.scale, ...view.offset, ...view.half, 0, 0]),
    );
    const encoder = this.device.createCommandEncoder({ label: 'render' });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target,
          clearValue: { r: 0.067, g: 0.078, b: 0.094, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.beltPipeline);
    pass.setBindGroup(0, this.beltGroup);
    pass.draw(4, this.segmentCount);
    pass.setPipeline(this.itemPipeline);
    pass.setBindGroup(0, this.itemGroups[this.current as 0 | 1]);
    const q = this.quadsPerInstance;
    pass.draw(6 * q, Math.ceil(this.items / q));
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Counts the current state on the GPU and reads the counters back
   * asynchronously (`Counter` in sim.ts), with the tick they describe; `null`
   * while a previous readback is still in flight.
   */
  readCounters(): Promise<{ tick: number; counters: Uint32Array }> | null {
    if (this.countersPending) return null;
    this.countersPending = true;
    const tick = this.tick;
    const encoder = this.device.createCommandEncoder({ label: 'count' });
    encoder.clearBuffer(this.counters);
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.countPipeline);
    pass.setBindGroup(0, this.countGroups[this.current as 0 | 1]);
    pass.dispatchWorkgroups(this.workgroups);
    pass.end();
    encoder.copyBufferToBuffer(this.counters, 0, this.countersRead, 0, COUNTER_WORDS * 4);
    this.device.queue.submit([encoder.finish()]);
    return this.countersRead.mapAsync(MAP_MODE_READ).then(
      () => {
        const counters = new Uint32Array(this.countersRead.getMappedRange().slice(0));
        this.countersRead.unmap();
        this.countersPending = false;
        return { tick, counters };
      },
      (e: unknown) => {
        this.countersPending = false;
        throw e;
      },
    );
  }

  /** Reads the whole current item state back. For tests on small item counts only. */
  async readItems(): Promise<Items> {
    const bytes = this.items * ITEM_BYTES;
    const read = (src: GPUBuffer): { src: GPUBuffer; dst: GPUBuffer } => ({
      src,
      dst: this.device.createBuffer({
        size: Math.max(16, bytes),
        usage: BUFFER.MAP_READ | BUFFER.COPY_DST,
      }),
    });
    const k = this.current as 0 | 1;
    const copies = [read(this.belt[k]), read(this.progress[k]), read(this.itemType)];
    const encoder = this.device.createCommandEncoder({ label: 'read items' });
    for (const c of copies) encoder.copyBufferToBuffer(c.src, 0, c.dst, 0, bytes);
    this.device.queue.submit([encoder.finish()]);
    const [belt, progress, itemType] = await Promise.all(
      copies.map(async ({ dst }) => {
        await dst.mapAsync(MAP_MODE_READ);
        const data = new Uint32Array(dst.getMappedRange(0, bytes).slice(0));
        dst.destroy();
        return data;
      }),
    );
    return { belt: belt!, progress: progress!, itemType: itemType! };
  }
}
