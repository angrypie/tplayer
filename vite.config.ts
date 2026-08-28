import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
	plugins: [
		tailwindcss(),
		react(),
		VitePWA({
			devOptions: {
				enabled: true,
			},
			includeAssets: [
				'favicon.ico',
				'mask-icon.svg',
				'apple-touch-icon-180x180.png',
			],
			manifest: {
				display: 'standalone',
				icons: [
					{
						sizes: '64x64',
						src: 'pwa-64x64.png',
						type: 'image/png',
					},
					{
						sizes: '192x192',
						src: 'pwa-192x192.png',
						type: 'image/png',
					},
					{
						sizes: '512x512',
						src: 'pwa-512x512.png',
						type: 'image/png',
					},
					{
						purpose: 'maskable',
						sizes: '512x512',
						src: 'maskable-icon-512x512.png',
						type: 'image/png',
					},
				],
				name: 'TPlayer - Audiobook Player',
				short_name: 'TPlayer',
				theme_color: '#ffffff',
			},
			registerType: 'autoUpdate',
		}),
	],
	resolve: {
		tsconfigPaths: true,
	},
	server: {
		proxy: {
			'/api': 'http://127.0.0.1:8082',
		},
	},
})
