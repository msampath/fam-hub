import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // globals: true exposes afterEach so @testing-library/react auto-cleanup runs
    // between tests (prevents leaked DOM across renders). Tests still import their
    // APIs explicitly, so this only enables the cleanup hook.
    globals: true,
    // Global env stays node (pure-logic tests). Component tests opt into jsdom with a
    // `// @vitest-environment jsdom` pragma at the top of the file.
    environment: 'node',
    // Force CLOUD-mode Supabase config for tests so src/supabase.ts builds its (mockable)
    // createClient instead of the local-SQLite Proxy stub, which THROWS on access. Without
    // this, the supabase* tests pass only when a developer's .env happens to set these — and
    // fail in CI (no .env), where the stub is used. Dummy values; the client is always mocked.
    env: {
      VITE_SUPABASE_URL: 'http://localhost:54321',
      VITE_SUPABASE_ANON_KEY: 'test-anon-key',
    },
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    setupFiles: ['src/__tests__/setup.ts'],
  },
});
