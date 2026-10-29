import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

// Dev-server config (single build). For production builds of main app + dApps,
// use `node scripts/build-dapps.js` which builds each dApp into its own
// dist/dapps/<name>/ output folder.
export default defineConfig({
  base: './',
  publicDir: 'public',
  plugins: [solid()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/ws/events': {
        target: 'http://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
      '/dapp': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
