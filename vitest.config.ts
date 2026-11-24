import { defineConfig } from 'vitest/config';

/**
 * Tests on the installed game files (`*.game.test.ts`) read all of vanilla and all mods —
 * hundreds of megabytes in memory per test file. They run as a separate `game` project: after
 * the light tests (groupOrder) and one file at a time, so several copies of vanilla
 * are not held in parallel processes. Without the game they skip themselves.
 */
export default defineConfig({
  test: {
    projects: [
      'packages/*',
      {
        test: {
          name: 'game',
          include: ['packages/*/test/**/*.game.test.ts'],
          fileParallelism: false,
          sequence: { groupOrder: 1 },
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
