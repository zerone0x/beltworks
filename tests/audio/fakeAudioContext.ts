/**
 * A fake `AudioContext` for unit tests: records the nodes made, their
 * connections and every scheduled parameter change, and makes no sound.
 * Only what src/audio uses is implemented.
 */

export interface ParamEvent {
  type: 'set' | 'linear' | 'exp' | 'target' | 'cancel';
  value: number;
  time: number;
}

export class FakeParam {
  readonly events: ParamEvent[] = [];
  constructor(public value = 0) {}
  setValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'set', value, time });
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'linear', value, time });
    this.value = value;
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number): this {
    if (value <= 0) throw new RangeError('exponential ramps need a positive value');
    this.events.push({ type: 'exp', value, time });
    this.value = value;
    return this;
  }
  setTargetAtTime(value: number, time: number): this {
    this.events.push({ type: 'target', value, time });
    this.value = value;
    return this;
  }
  cancelScheduledValues(time: number): this {
    this.events.push({ type: 'cancel', value: this.value, time });
    return this;
  }
}

export class FakeNode {
  readonly connections: (FakeNode | FakeParam)[] = [];
  constructor(
    readonly ctx: FakeAudioContext,
    readonly kind: string,
  ) {
    ctx.nodes.push(this);
  }
  connect<T extends FakeNode | FakeParam>(target: T): T {
    this.connections.push(target);
    return target;
  }
  disconnect(): void {
    this.connections.length = 0;
  }
}

export class FakeSource extends FakeNode {
  type = 'sine';
  readonly frequency = new FakeParam(440);
  readonly detune = new FakeParam(0);
  buffer: unknown = null;
  loop = false;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  start(time = 0): void {
    this.startedAt = time;
  }
  stop(time = 0): void {
    this.stoppedAt = time;
  }
  addEventListener(): void {}
}

export class FakeAudioContext {
  readonly nodes: FakeNode[] = [];
  readonly destination: FakeNode;
  currentTime = 0;
  sampleRate = 8000;
  state: 'running' | 'suspended' | 'closed' = 'running';
  resumes = 0;
  suspends = 0;

  constructor() {
    this.destination = new FakeNode(this, 'destination');
  }

  createGain() {
    return Object.assign(new FakeNode(this, 'gain'), { gain: new FakeParam(1) });
  }
  createOscillator() {
    return new FakeSource(this, 'oscillator');
  }
  createBufferSource() {
    return new FakeSource(this, 'buffer-source');
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(this, 'biquad'), {
      type: 'lowpass',
      frequency: new FakeParam(350),
      Q: new FakeParam(1),
    });
  }
  createStereoPanner() {
    return Object.assign(new FakeNode(this, 'panner'), { pan: new FakeParam(0) });
  }
  createDynamicsCompressor() {
    return Object.assign(new FakeNode(this, 'compressor'), {
      threshold: new FakeParam(-24),
      knee: new FakeParam(30),
      ratio: new FakeParam(12),
      attack: new FakeParam(0.003),
    });
  }
  createDelay() {
    return Object.assign(new FakeNode(this, 'delay'), { delayTime: new FakeParam(0) });
  }
  createBuffer(_channels: number, length: number) {
    const data = new Float32Array(length);
    return { length, getChannelData: () => data };
  }
  resume(): Promise<void> {
    this.resumes++;
    this.state = 'running';
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.suspends++;
    this.state = 'suspended';
    return Promise.resolve();
  }

  /** The fake as the real type, for code under test. */
  get asReal(): AudioContext {
    return this as unknown as AudioContext;
  }

  nodesOf(kind: string): FakeNode[] {
    return this.nodes.filter((n) => n.kind === kind);
  }
}

/** Whether `from` reaches `to` through connections. */
export function reaches(from: FakeNode, to: FakeNode): boolean {
  const seen = new Set<FakeNode>();
  const stack = [from];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const c of n.connections) if (c instanceof FakeNode) stack.push(c);
  }
  return false;
}
