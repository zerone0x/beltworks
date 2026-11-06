/** Every benchmark scene, in the order the runner runs them. Add new scenes here. */

import type { BenchScene } from '../scene';
import { factory1k } from './factory1k';
import { power } from './power';

export const SCENES: readonly BenchScene[] = [factory1k, power];
