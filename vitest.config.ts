import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node', // Use node for most tests
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    exclude: ['node_modules', '.next'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // v1.4.0: include app/api/** so the route-level tests we added (ingest,
      // admin/documents/upload, chat/stream, etc.) actually move the needle on
      // the coverage report. Previously these routes were invisible to v8.
      include: [
        'lib/**/*.ts',
        'actions/**/*.ts',
        'components/**/*.tsx',
        'app/api/**/*.ts',
      ],
      exclude: ['node_modules', '.next', 'test/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
