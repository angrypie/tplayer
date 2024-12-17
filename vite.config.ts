import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import path from "path"
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
	plugins: [
		react(),
		VitePWA({
			registerType: 'autoUpdate',
			includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'mask-icon.svg', 'apple-touch-icon-180x180.png'],
			manifest: {
				short_name: 'TPlayer',
				name: 'TPlayer - Audiobook Player',
				theme_color: '#ffffff',
				display: 'standalone',
			},
			devOptions: {
				enabled: true
			}
		}),
	],
	resolve: {
		alias: {
			"~": path.resolve(__dirname, "./src"),
		},
	},
})
