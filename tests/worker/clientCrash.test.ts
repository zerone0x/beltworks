/**
 * D61 with D64: the worker can fail before the game sets `onCrash` (it does
 * so only once the renderer's code has loaded). The crash must still reach
 * the listener, once, when it is set.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimClient } from '../../src/worker/client';

/** A stand-in for the browser's Worker: records nothing, lets the test fail it. */
class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(): void {}
  terminate(): void {
    this.terminated = true;
  }
}

beforeEach(() => {
  vi.stubGlobal('Worker', FakeWorker);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SimClient crashes', () => {
  it('reports a crash from before onCrash was set as soon as it is set', () => {
    const client = new SimClient(1);
    FakeWorker.last!.onerror!({ message: 'worker script failed to load' });
    expect(client.crashed).toBe('worker script failed to load');
    const onCrash = vi.fn();
    client.onCrash = onCrash;
    expect(onCrash).toHaveBeenCalledExactlyOnceWith('worker script failed to load');
    // Setting it again doesn't report the crash again.
    const again = vi.fn();
    client.onCrash = again;
    expect(again).not.toHaveBeenCalled();
  });

  it('reports a crash after onCrash was set right away, once', () => {
    const client = new SimClient(1);
    const onCrash = vi.fn();
    client.onCrash = onCrash;
    expect(onCrash).not.toHaveBeenCalled();
    FakeWorker.last!.onmessage!({
      data: { type: 'crashed', message: 'tick threw' },
    } as MessageEvent);
    FakeWorker.last!.onerror!({ message: 'and then the worker failed' });
    expect(onCrash).toHaveBeenCalledExactlyOnceWith('tick threw');
    expect(client.crashed).toBe('tick threw');
  });

  it('rejects saves once crashed', async () => {
    const client = new SimClient(1);
    FakeWorker.last!.onerror!({ message: 'gone' });
    await expect(client.save()).rejects.toThrow('the simulation stopped');
  });
});
