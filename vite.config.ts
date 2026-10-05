import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// Tauri expects a fixed dev port and must see Rust compiler errors in the terminal.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**', '**/crates/**', '**/target/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    environment: 'node',
  },
});
