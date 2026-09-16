import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'next/navigation': path.resolve(__dirname, './src/shims/next-navigation.ts'),
      'next/link': path.resolve(__dirname, './src/shims/next-link.tsx'),
      'next/image': path.resolve(__dirname, './src/shims/next-image.tsx'),
      'next/server': path.resolve(__dirname, './src/shims/next-server.ts'),
    },
  },
  server: {
    port: 3100,
    proxy: {
      '/api': {
        target: 'http://localhost:3101',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist/client',
  },
});
