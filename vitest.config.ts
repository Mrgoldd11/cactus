import { defineConfig } from 'vitest/config';

/**
 * Тесты на файлах установленной игры (`*.game.test.ts`) читают всю ваниль и все моды —
 * сотни мегабайт в памяти на файл тестов. Они идут отдельным проектом `game`: после
 * лёгких тестов (groupOrder) и по одному файлу за раз, чтобы не держать несколько копий
 * ванили в параллельных процессах. Без игры они пропускаются сами.
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
