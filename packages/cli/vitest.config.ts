import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'cli',
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.game.test.ts'],
    // Building Skeleton Cannibal Friend reads all of vanilla and the translation — a few seconds.
    testTimeout: 120_000,
  },
});
