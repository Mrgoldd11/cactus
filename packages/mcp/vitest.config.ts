import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'mcp',
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.game.test.ts'],
    // Server and client in memory; on a cold start importing the SDK and the core can take longer than 5 s.
    testTimeout: 30_000,
  },
});
