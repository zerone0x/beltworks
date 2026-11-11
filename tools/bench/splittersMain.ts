/** `npm run bench:splitters`: prints the splitter micro-benchmark (splitters.ts). */
import { measureSplitters } from './splitters';

const { medianMs, minMs, activeLanes } = measureSplitters();
console.log(
  `splitters: ${medianMs.toFixed(4)} ms per belt tick (median of 7 runs of 2000 ticks), fastest ${minMs.toFixed(4)}, ${String(activeLanes)} active lanes`,
);
