import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Testes de integração com Postgres rodam em série para não disputar o mesmo banco.
    fileParallelism: false,
  },
});
