import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/api.test.ts', 'tests/layers.test.ts'], testTimeout: 15_000 },
});
