import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // VITE_API_URL is injected at build time via --mode or the environment.
  // Defaults to empty string so relative paths work for local dev without nginx.
  define: {
    __API_URL__: JSON.stringify(process.env.VITE_API_URL ?? ''),
  },
});
