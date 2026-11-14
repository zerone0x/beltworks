/**
 * The scene builder moved into the game (src/sim/scenarios/builder.ts) when
 * the demo factory started using it too (docs/DECISIONS.md, D72); the
 * benchmark scenes keep importing it from here.
 */

export * from '../../src/sim/scenarios/builder';
