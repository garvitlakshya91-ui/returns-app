import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/portal/',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3003',
    },
  },
  build: {
    outDir: 'dist',
  },
})
