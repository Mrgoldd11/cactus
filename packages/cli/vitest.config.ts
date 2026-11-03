import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'cli',
    include: ['test/**/*.test.ts'],
    // Сборка Skeleton Cannibal Friend читает всю ваниль и перевод — несколько секунд.
    testTimeout: 120_000,
  },
});
