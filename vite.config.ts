import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

let tailwindPlugin: any = null
try {
  // @ts-ignore
  const tw = await import("@tailwindcss/vite")
  tailwindPlugin = tw.default()
} catch (e) {
  // Graceful fallback if @tailwindcss/vite is not yet installed in node_modules
}

export default defineConfig({
  plugins: [react(), ...(tailwindPlugin ? [tailwindPlugin] : [])],
  server: {
    port: 5185,
  },
})
