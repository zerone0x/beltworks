/**
 * The headless benchmark runner behind `npm run bench`.
 *
 *   npm run bench [-- options]
 *
 * Options:
 *   --scene <name>         run only this scene (repeatable; default: all)
 *   --warmup <ticks>       warm-up ticks per run (default 600)
 *   --ticks <ticks>        measured ticks per run (default 3600)
 *   --runs <n>             runs per scene; the median run is reported (default 5)
 *   --warmup-runs <n>      untimed runs per scene before those (default 3)
 *   --json <file>          write the report as JSON
 *   --md <file>            write the report as a Markdown table
 *   --baseline <file>      compare against a baseline report (e.g. tools/bench/baseline.json)
 *   --compare-md <file>    write the comparison as Markdown
 *   --threshold <ratio>    mean tick time growth that counts as a regression (default 0.2)
 *   --fail-on-regression   exit with status 1 on a regression (default: only warn)
 *   --update-baseline      overwrite the --baseline file with this run
 *
 * The Markdown table (and the comparison) also go to stdout. Regressions are
 * printed as GitHub Actions warnings when running in Actions.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, arch, platform } from 'node:os';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { MEASURED_TICKS, RUNS, WARMUP_RUNS, WARMUP_TICKS, measureScene } from './measure';
import {
  DEFAULT_REGRESSION_THRESHOLD,
  REPORT_VERSION,
  compareReports,
  comparisonMarkdown,
  reportMarkdown,
  type BenchReport,
} from './report';
import { SCENES } from './scenes/index';

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative integer, got ${value}`);
  }
  return n;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      scene: { type: 'string', multiple: true },
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
    },
  });

  const names = values.scene ?? SCENES.map((s) => s.name);
  const unknown = names.filter((n) => !SCENES.some((s) => s.name === n));
  if (unknown.length > 0) {
    throw new Error(
      `unknown scene(s): ${unknown.join(', ')} (have: ${SCENES.map((s) => s.name).join(', ')})`,
    );
  }
  const warmupTicks = positiveInt(values.warmup, WARMUP_TICKS, 'warmup');
  const measuredTicks = positiveInt(values.ticks, MEASURED_TICKS, 'ticks');
  const runs = Math.max(1, positiveInt(values.runs, RUNS, 'runs'));
  const warmupRuns = positiveInt(values['warmup-runs'], WARMUP_RUNS, 'warmup-runs');
  const threshold =
    values.threshold === undefined ? DEFAULT_REGRESSION_THRESHOLD : Number(values.threshold);
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error(`--threshold must be a non-negative number, got ${String(values.threshold)}`);
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
    report.scenes.push(measureScene(scene, { warmupTicks, measuredTicks, runs, warmupRuns }));
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
    const md = comparisonMarkdown(comparison);
    process.stdout.write(`\nCompared with ${values.baseline}:\n\n${md}\n`);
    if (values['compare-md']) writeFile(values['compare-md'], `${md}\n`);
    for (const s of comparison.regressions) {
      const message = `Benchmark scene ${s.name}: mean tick ${s.current.meanMs.toFixed(4)} ms vs baseline ${s.baseline?.meanMs.toFixed(4) ?? 'n/a'} ms (${((s.meanChange ?? 0) * 100).toFixed(1)}% slower)`;
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
