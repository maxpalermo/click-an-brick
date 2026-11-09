import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/builder/',
  // Pre-bundle the converter worker's loaders so the first photo build doesn't trigger a dev reload.
  optimizeDeps: {
    include: [
      'three/examples/jsm/loaders/GLTFLoader.js',
      'three/examples/jsm/loaders/DRACOLoader.js',
      'three/examples/jsm/libs/meshopt_decoder.module.js',
    ],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/ldraw': 'http://localhost:8787',
    },
  },
});
