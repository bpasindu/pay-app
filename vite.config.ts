import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import { cloudflare } from "@cloudflare/vite-plugin";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cloudflare()],
  server: {
    allowedHosts: [
      'unthrust-guileless-diedra.ngrok-free.dev', // Allows your specific ngrok tunnel
      '.ngrok-free.app',                         // Allows any generic ngrok tunnels
      '.ngrok-free.dev'                          // Allows newer ngrok domains
    ]
  }
})