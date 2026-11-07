/**
 * Benchmark reports: the JSON written by `npm run bench -- --json <file>`
 * (also the format of tools/bench/baseline.json), its Markdown table, and the
 * comparison against a baseline.
 */

import type { SceneResult } from './measure';

export const REPORT_VERSION = 1;

/** Mean tick time growth over the baseline that counts as a regression (20%). */
export const DEFAULT_REGRESSION_THRESHOLD = 0.2;

export interface BenchEnvironment {
  node: string;
  platform: string;
  arch: string;
  cpu: string;
  cpus: number;
}

export interface BenchReport {
  version: number;
  createdAt: string;
  /** Commit the run was made on, when known (e.g. `GITHUB_SHA` in CI). */
  commit?: string;
  environment: BenchEnvironment;
  scenes: SceneResult[];
}

const ms = (v: number): string => v.toFixed(4);
const rate = (v: number): string => Math.round(v).toLocaleString('en-US');

/** How a scene was run: ticks per run, runs, untimed runs. */
function runSettings(
  s: Pick<SceneResult, 'warmupTicks' | 'measuredTicks' | 'warmupRuns'> & {
    runs: readonly unknown[];
  },
): string {
  return (
    `${String(s.warmupTicks)} warm-up + ${String(s.measuredTicks)} measured ticks per run, ` +
    `median of ${String(s.runs.length)} runs by mean, after ${String(s.warmupRuns)} untimed runs`
  );
}

const count = (v: number): string => v.toLocaleString('en-US');

/**
 * A Markdown table of the report's scenes, then the work the scenes did
 * during the measured ticks and their per-system profiles, where they have
 * them.
 */
export function reportMarkdown(report: BenchReport): string {
  const { environment: env } = report;
  const machine = `Node ${env.node} on ${env.cpu} (${String(env.cpus)} CPUs, ${env.platform}/${env.arch}).`;
  const lines = [
    '| Scene | Entities | Belt items | Mean (ms) | p50 (ms) | p99 (ms) | Max (ms) | Ticks/s | Target mean |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---|',
    ...report.scenes.map((s) => {
      const target = `< ${String(s.targetMeanMs)} ms ${s.meanMs < s.targetMeanMs ? 'met' : '**missed**'}`;
      return `| ${s.name} | ${String(s.entities)} | ${String(s.beltItems)} | ${ms(s.meanMs)} | ${ms(s.p50Ms)} | ${ms(s.p99Ms)} | ${ms(s.maxMs)} | ${rate(s.ticksPerSecond)} | ${target} |`;
    }),
    '',
  ];
  // One line when every scene ran the same way, else one per scene.
  const settings = [...new Set(report.scenes.map(runSettings))];
  if (settings.length > 1) {
    lines.push(...report.scenes.map((s) => `- \`${s.name}\`: ${runSettings(s)}.`), '', machine);
  } else {
    const first = report.scenes[0];
    const none = { warmupTicks: 0, measuredTicks: 0, warmupRuns: 0, runs: [] };
    lines.push(`${runSettings(first ?? none)}; ${machine}`);
  }
  const worked = report.scenes.filter((s) => s.work);
  if (worked.length > 0) {
    lines.push('', 'Work during the measured ticks (before → after):', '');
    for (const s of worked) {
      const { before, after } = s.work!;
      const parts = Object.keys(after).map(
        (k) => `${k} ${count(before[k] ?? 0)} → ${count(after[k] ?? 0)}`,
      );
      lines.push(`- \`${s.name}\`: ${parts.join(', ')}`);
    }
  }
  const profiled = report.scenes.filter((s) => s.profile);
  if (profiled.length > 0) {
    lines.push(
      '',
      'Per-system time per tick in ms (share of the profiled tick), from one extra profiled run per scene:',
      '',
      `| System | ${profiled.map((s) => s.name).join(' | ')} |`,
      `|---|${profiled.map(() => '---:').join('|')}|`,
    );
    for (const { name } of profiled[0]!.profile!.stages) {
      const cells = profiled.map((s) => {
        const t = s.profile!.stages.find((x) => x.name === name);
        return t ? `${ms(t.meanMs)} (${(t.share * 100).toFixed(1)}%)` : 'n/a';
      });
      lines.push(`| ${name} | ${cells.join(' | ')} |`);
    }
    lines.push(`| total | ${profiled.map((s) => ms(s.profile!.meanMs)).join(' | ')} |`);
  }
  return lines.join('\n');
}

export interface SceneComparison {
  name: string;
  current: SceneResult;
  baseline?: SceneResult;
  /** Relative change of the mean tick time, e.g. 0.25 for 25% slower. */
  meanChange?: number;
  p50Change?: number;
  p99Change?: number;
  regressed: boolean;
  /** The scene's end state differs from the baseline's (scene or simulation changed). */
  stateChanged: boolean;
}

export interface Comparison {
  threshold: number;
  scenes: SceneComparison[];
  regressions: SceneComparison[];
  /**
   * The baseline's CPU model, when it differs from this run's. GitHub's
   * `ubuntu-latest` pool mixes CPU models, and that alone can move the
   * microsecond-scale tick times by more than the threshold.
   */
  baselineCpu?: string;
  cpu: string;
}

const change = (current: number, baseline: number): number | undefined =>
  baseline > 0 ? current / baseline - 1 : undefined;

/**
 * Compares every scene of `current` with the scene of the same name in
 * `baseline`. A scene regressed when its mean tick time grew by more than
 * `threshold` (0.2 = 20%).
 */
export function compareReports(
  baseline: BenchReport,
  current: BenchReport,
  threshold: number = DEFAULT_REGRESSION_THRESHOLD,
): Comparison {
  const scenes = current.scenes.map((s): SceneComparison => {
    const base = baseline.scenes.find((b) => b.name === s.name);
    if (!base) {
      return { name: s.name, current: s, regressed: false, stateChanged: false };
    }
    const meanChange = change(s.meanMs, base.meanMs);
    const result: SceneComparison = {
      name: s.name,
      current: s,
      baseline: base,
      regressed: meanChange !== undefined && meanChange > threshold,
      stateChanged: s.hash !== base.hash || s.entities !== base.entities,
    };
    if (meanChange !== undefined) result.meanChange = meanChange;
    const p50Change = change(s.p50Ms, base.p50Ms);
    if (p50Change !== undefined) result.p50Change = p50Change;
    const p99Change = change(s.p99Ms, base.p99Ms);
    if (p99Change !== undefined) result.p99Change = p99Change;
    return result;
  });
  const result: Comparison = {
    threshold,
    scenes,
    regressions: scenes.filter((s) => s.regressed),
    cpu: current.environment.cpu,
  };
  if (baseline.environment.cpu !== current.environment.cpu) {
    result.baselineCpu = baseline.environment.cpu;
  }
  return result;
}

const pct = (v: number | undefined): string =>
  v === undefined ? 'n/a' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

/** A Markdown table of the comparison, with a warning line per regression. */
export function comparisonMarkdown(
  comparison: Comparison,
  baselinePath = 'tools/bench/baseline.json',
): string {
  const lines = [
    '| Scene | Mean (ms) | Δ mean | p50 (ms) | Δ p50 | p99 (ms) | Δ p99 | Status |',
    '|---|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const s of comparison.scenes) {
    const { current: c, baseline: b } = s;
    const vs = (cur: number, base: number | undefined): string =>
      base === undefined ? ms(cur) : `${ms(cur)} (was ${ms(base)})`;
    const status = !b
      ? 'no baseline'
      : s.regressed
        ? `**regressed** (> ${(comparison.threshold * 100).toFixed(0)}%)`
        : 'ok';
    lines.push(
      `| ${s.name} | ${vs(c.meanMs, b?.meanMs)} | ${pct(s.meanChange)} | ${vs(c.p50Ms, b?.p50Ms)} | ${pct(s.p50Change)} | ${vs(c.p99Ms, b?.p99Ms)} | ${pct(s.p99Change)} | ${status} |`,
    );
  }
  const notes = comparison.scenes.flatMap((s) => {
    const out: string[] = [];
    if (s.regressed) {
      out.push(
        `> [!WARNING]\n> Scene \`${s.name}\`: mean tick time ${pct(s.meanChange)} over the baseline (threshold ${(comparison.threshold * 100).toFixed(0)}%).`,
      );
    }
    if (s.stateChanged) {
      out.push(
        `Scene \`${s.name}\` ends in a different state than the baseline (hash ${s.current.hash}, was ${s.baseline?.hash ?? 'n/a'}): ` +
          `the scene or the simulation changed. If that is intended, update \`${baselinePath}\`.`,
      );
    }
    return out;
  });
  if (comparison.baselineCpu !== undefined) {
    notes.push(
      `This run's CPU (${comparison.cpu}) differs from the baseline's (${comparison.baselineCpu}): ` +
        'differences of this size can come from the hardware alone.',
    );
  }
  return [...lines, ...(notes.length > 0 ? ['', notes.join('\n\n')] : [])].join('\n');
}
