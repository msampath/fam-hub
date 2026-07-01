import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    // Pre-bundle the heavy, eagerly-imported deps deterministically (cached in node_modules/.vite) so a
    // dev cold-start doesn't discover + bundle them on every boot — the main lever on the slow first load.
    optimizeDeps: {
      include: ['@supabase/supabase-js', 'react', 'react-dom', 'lucide-react', 'react-markdown', 'remark-gfm'],
    },
    build: {
      rollupOptions: {
        output: {
          // Split stable vendor code into its own chunks so (a) no single chunk trips Vite's
          // 500 kB warning and (b) the React/Supabase vendor stays cached across app-only
          // deploys. Path-delimited matches avoid catching 'lucide-react' as 'react'.
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('/@supabase/')) return 'supabase';
            if (id.includes('/react-dom/') || id.includes('/react/') || id.includes('/scheduler/')) return 'react-vendor';
            return 'vendor';
          },
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
