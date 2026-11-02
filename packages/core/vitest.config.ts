import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'core',
    include: ['test/**/*.test.ts'],
    // Файлы игры большие (Dialogue.mod ~12 МБ), полный прогон модов — несколько секунд.
    testTimeout: 120_000,
  },
});
