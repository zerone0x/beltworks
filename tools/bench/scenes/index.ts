/** Every benchmark scene, in the order the runner runs them. Add new scenes here. */

import type { BenchScene } from '../scene';
import { factory10k, factory50k } from './factory';
import { factory1k } from './factory1k';
import { m3 } from './m3';
import { power } from './power';

export const SCENES: readonly BenchScene[] = [factory1k, power, m3, factory10k, factory50k];
