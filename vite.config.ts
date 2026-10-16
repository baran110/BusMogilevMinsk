import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fixtureApi } from './tests/support/vite-api'

export default defineConfig({
  plugins: [react(), ...(process.env.E2E_FIXTURES === '1' ? [fixtureApi()] : [])],
  server: {
    port: 4173,
  },
})
