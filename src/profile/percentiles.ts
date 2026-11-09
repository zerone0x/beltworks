/** Percentiles of a list of measurements (the render profile and the snapshot meter). */

export interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

/** p50, p95, p99, max and mean of `values` (zeros for none). */
export function percentiles(values: readonly number[]): Percentiles {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1]!, mean };
}
