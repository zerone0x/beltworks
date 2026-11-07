/**
 * The headless benchmark runner behind `npm run bench`.
 *
 *   npm run bench [-- [scene...] options]
 *
 * Scenes are named as arguments (`npm run bench -- 10k`) or with --scene.
 * Without names, every scene except the heavy ones (10k, 50k) runs.
 *
 * Options:
 *   --scene <name>         run this scene (repeatable)
 *   --all                  run every scene, heavy ones included
 *   --warmup <ticks>       warm-up ticks per run (default 600; 1200 for heavy scenes)
 *   --ticks <ticks>        measured ticks per run (default 3600)
 *   --runs <n>             runs per scene; the median run is reported (default 5; 3 for heavy scenes)
 *   --warmup-runs <n>      untimed runs per scene before those (default 3; 0 for heavy scenes)
 *   --profile              add one profiled run per scene: per-system timings (profile.ts)
 *   --json <file>          write the report as JSON
 *   --md <file>            write the report as a Markdown table
 *   --baseline <file>      compare against a baseline report (e.g. tools/bench/baseline.json)
 *   --compare-md <file>    write the comparison as Markdown
 *   --threshold <ratio>    mean tick time growth that counts as a regression (default 0.2)
 *   --fail-on-regression   exit with status 1 on a regression (default: only warn)
 *   --update-baseline      overwrite the --baseline file with this run
 *   --snapshot             measure snapshot encoding and transfer instead of tick time
 *                          (snapshot.ts; --warmup and --ticks apply, default 600 measured ticks)
 *
 * The Markdown table (and the comparison) also go to stdout. Regressions are
 * printed as GitHub Actions warnings when running in Actions.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, arch, platform } from 'node:os';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { WARMUP_TICKS, measureScene, type MeasureOptions } from './measure';
import {
  DEFAULT_REGRESSION_THRESHOLD,
  REPORT_VERSION,
  compareReports,
  comparisonMarkdown,
  reportMarkdown,
  type BenchReport,
} from './report';
import { SCENES } from './scenes/index';
import {
  SNAPSHOT_TICKS,
  measureSnapshots,
  snapshotMarkdown,
  type SnapshotResult,
} from './snapshot';

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function nonNegativeInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative integer, got ${value}`);
  }
  return n;
}

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      scene: { type: 'string', multiple: true },
      all: { type: 'boolean', default: false },
      profile: { type: 'boolean', default: false },
      warmup: { type: 'string' },
      ticks: { type: 'string' },
      runs: { type: 'string' },
      'warmup-runs': { type: 'string' },
      json: { type: 'string' },
      md: { type: 'string' },
      baseline: { type: 'string' },
      'compare-md': { type: 'string' },
      threshold: { type: 'string' },
      'fail-on-regression': { type: 'boolean', default: false },
      'update-baseline': { type: 'boolean', default: false },
      snapshot: { type: 'boolean', default: false },
    },
  });

  const asked = [...positionals, ...(values.scene ?? [])];
  const names =
    asked.length > 0 ? asked : SCENES.filter((s) => values.all || !s.heavy).map((s) => s.name);
  const unknown = names.filter((n) => !SCENES.some((s) => s.name === n));
  if (unknown.length > 0) {
    throw new Error(
      `unknown scene(s): ${unknown.join(', ')} (have: ${SCENES.map((s) => s.name).join(', ')})`,
    );
  }
  // Options left out fall back to each scene's defaults, then the global ones (measure.ts).
  const options: MeasureOptions = { profile: values.profile };
  const warmupTicks = nonNegativeInt(values.warmup, 'warmup');
  if (warmupTicks !== undefined) options.warmupTicks = warmupTicks;
  const measuredTicks = nonNegativeInt(values.ticks, 'ticks');
  if (measuredTicks !== undefined) options.measuredTicks = measuredTicks;
  const runs = nonNegativeInt(values.runs, 'runs');
  if (runs !== undefined) options.runs = Math.max(1, runs);
  const warmupRuns = nonNegativeInt(values['warmup-runs'], 'warmup-runs');
  if (warmupRuns !== undefined) options.warmupRuns = warmupRuns;
  const threshold =
    values.threshold === undefined ? DEFAULT_REGRESSION_THRESHOLD : Number(values.threshold);
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error(`--threshold must be a non-negative number, got ${String(values.threshold)}`);
  }

  if (values.snapshot) {
    const results: SnapshotResult[] = [];
    for (const scene of SCENES.filter((s) => names.includes(s.name))) {
      process.stderr.write(`bench: ${scene.name}: building, then measuring snapshots...\n`);
      const { sim } = scene.build();
      const warmup = warmupTicks ?? scene.defaults?.warmupTicks ?? WARMUP_TICKS;
      for (let i = 0; i < warmup; i++) sim.step();
      results.push(measureSnapshots(scene.name, sim, measuredTicks ?? SNAPSHOT_TICKS));
    }
    const markdown = snapshotMarkdown(results);
    process.stdout.write(`${markdown}\n`);
    if (values.json) writeFile(values.json, `${JSON.stringify(results, null, 2)}\n`);
    if (values.md) writeFile(values.md, `${markdown}\n`);
    return;
  }

  const cpuList = cpus();
  const report: BenchReport = {
    version: REPORT_VERSION,
    createdAt: new Date().toISOString(),
    ...(process.env.GITHUB_SHA ? { commit: process.env.GITHUB_SHA } : {}),
    environment: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      cpu: cpuList[0]?.model.trim() ?? 'unknown',
      cpus: cpuList.length,
    },
    scenes: [],
  };
  for (const scene of SCENES.filter((s) => names.includes(s.name))) {
    process.stderr.write(`bench: ${scene.name}: building and running...\n`);
    const started = performance.now();
    report.scenes.push(measureScene(scene, options));
    process.stderr.write(
      `bench: ${scene.name}: done in ${((performance.now() - started) / 1000).toFixed(1)} s\n`,
    );
  }

  const markdown = reportMarkdown(report);
  process.stdout.write(`${markdown}\n`);
  if (values.json) writeFile(values.json, `${JSON.stringify(report, null, 2)}\n`);
  if (values.md) writeFile(values.md, `${markdown}\n`);

  let regressed = false;
  if (values.baseline && values['update-baseline']) {
    writeFile(values.baseline, `${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`bench: wrote baseline ${values.baseline}\n`);
  } else if (values.baseline) {
    const baseline = JSON.parse(readFileSync(values.baseline, 'utf8')) as BenchReport;
    const comparison = compareReports(baseline, report, threshold);
    const md = comparisonMarkdown(comparison, values.baseline);
    process.stdout.write(`\nCompared with ${values.baseline}:\n\n${md}\n`);
    if (values['compare-md']) writeFile(values['compare-md'], `${md}\n`);
    for (const s of comparison.regressions) {
      const message = `Benchmark scene ${s.name}: mean tick ${s.current.meanMs.toFixed(4)} ms vs baseline ${s.baseline?.meanMs.toFixed(4) ?? 'n/a'} ms (${((s.meanChange ?? 0) * 100).toFixed(1)}% slower)${comparison.baselineCpu === undefined ? '' : `; note: baseline CPU ${comparison.baselineCpu}, this run ${comparison.cpu}`}`;
      process.stdout.write(
        process.env.GITHUB_ACTIONS
          ? `::warning title=Benchmark regression::${message}\n`
          : `WARNING: ${message}\n`,
      );
    }
    regressed = comparison.regressions.length > 0;
  }
  if (regressed && values['fail-on-regression']) {
    process.exitCode = 1;
  }
}

main();
