import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'mcp',
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.game.test.ts'],
    // Сервер и клиент в памяти; при холодном старте импорт SDK и ядра бывает дольше 5 с.
    testTimeout: 30_000,
  },
});
