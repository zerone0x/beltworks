/**
 * Expected final state hash of the determinism scenario
 * (src/sim/scenarios/determinism.ts). Both the Node test
 * (tests/sim/determinism.test.ts) and the Chromium test
 * (tests/e2e/determinism.spec.ts) compare against this one value.
 *
 * It changes whenever the simulation's behavior or hashed state changes. When
 * that is intended, run `npm test`, check that the change is expected, and
 * paste the new value printed by the failing assertion here.
 */
export const DETERMINISM_EXPECTED_HASH = 0xaccdabc1;
