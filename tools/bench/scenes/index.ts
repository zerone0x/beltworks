/** Every benchmark scene, in the order the runner runs them. Add new scenes here. */

import type { BenchScene } from '../scene';
import { factory10k, factory50k } from './factory';
import { factory1k } from './factory1k';
import { power } from './power';

export const SCENES: readonly BenchScene[] = [factory1k, power, factory10k, factory50k];
