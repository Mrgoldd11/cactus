import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'core',
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.game.test.ts'],
    // The game files are big (Dialogue.mod ~12 MB), a full run over the mods takes a few seconds.
    testTimeout: 120_000,
  },
});
