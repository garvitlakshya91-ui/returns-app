import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Manual chunking — without this, Polaris + recharts + App Bridge all land
// in one 1.1 MB bundle. Splitting them lets the browser cache vendor code
// across releases and pre-fetch chart code only when /analytics is opened.
export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  server: {
    port: 5180,
    proxy: {
      '/api': 'http://localhost:3003',
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('@shopify/polaris')) return 'polaris';
          if (id.includes('@shopify/app-bridge')) return 'app-bridge';
          if (id.includes('recharts') || id.includes('d3-')) return 'charts';
          if (id.includes('react-router')) return 'react-vendor';
          if (id.includes('/react/') || id.includes('/react-dom/')) return 'react-vendor';
        },
      },
    },
  },
})
