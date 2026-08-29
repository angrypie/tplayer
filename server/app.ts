import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import type { AppConfig } from './config'
import type { AppDatabase } from './database'
import { asError, HttpError } from './errors'
import type { AppLogger } from './logger'
import { createSearchRoutes } from './search/routes'
import {
	type AudiobookSearchService,
	createAudiobookSearchService,
} from './search/service'
import type { TorrentManager } from './torrent/manager'
import { createTorrentRoutes, fileResponse } from './torrent/routes'

const LEADING_SLASH_PATTERN = /^\/+/

export interface AppDependencies {
	config: AppConfig
	database: AppDatabase
	logger: AppLogger
	manager: TorrentManager
	searchService?: AudiobookSearchService
	serveFrontend?: boolean
}

const errorBody = (code: string, message: string): object => ({
	error: { code, message },
})

export const createApp = ({
	config,
	database,
	logger,
	manager,
	searchService = createAudiobookSearchService(),
	serveFrontend = true,
}: AppDependencies): Hono => {
	const app = new Hono()
	app.use('*', requestId())
	app.use('*', secureHeaders())
	app.use('*', async (context, next) => {
		const startedAt = performance.now()
		await next()
		logger.info('HTTP request', {
			durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
			method: context.req.method,
			path: context.req.path,
			requestId: context.get('requestId'),
			status: context.res.status,
		})
	})

	app.get('/api/health', (context) => {
		const databaseHealth = database.healthCheck()
		const healthy =
			databaseHealth.integrity === 'ok' && !manager.health().destroyed
		return context.json(
			{
				database: databaseHealth,
				status: healthy ? 'ok' : 'degraded',
				torrent: manager.health(),
			},
			healthy ? 200 : 503
		)
	})

	app.route('/api', createTorrentRoutes({ manager }))
	app.route('/api', createSearchRoutes({ manager, searchService }))

	// Compatibility with the previous Confluence-backed client. New client code
	// uses the typed resource routes above, but these keep old saved PWAs usable.
	app.get('/api/info', async (context) => {
		const bytes = await manager.infoBytes(
			context.req.query('ih') ?? '',
			context.req.raw.signal
		)
		return new Response(Uint8Array.from(bytes).buffer, {
			headers: {
				'Content-Length': String(bytes.byteLength),
				'Content-Type': 'application/x-bittorrent',
			},
		})
	})

	app.get('/api/data', async (context) => {
		const infoHash = context.req.query('ih') ?? ''
		const path = context.req.query('path')
		if (!path) {
			return context.json(
				errorBody('file_path_required', 'A torrent file path is required'),
				400
			)
		}
		const details = await manager.details(infoHash, context.req.raw.signal)
		const requested = path
			.replaceAll('\\', '/')
			.replace(LEADING_SLASH_PATTERN, '')
		const file = details.files.find(
			(candidate) => candidate.path.join('/') === requested
		)
		if (!file) {
			return context.json(
				errorBody('file_not_found', 'Torrent file was not found'),
				404
			)
		}
		return await fileResponse(manager, infoHash, file.id, context.req.raw)
	})

	app.get('/api/preload', (context) => {
		const status = manager.startPreload(context.req.query('ih') ?? '')
		return context.json({ status: status.state })
	})

	app.all('/api/*', (context) =>
		context.json(errorBody('not_found', 'API route was not found'), 404)
	)

	if (serveFrontend) {
		const staticFiles = serveStatic({
			onFound: (path, context) => {
				if (path.includes(`${join(config.frontendDirectory, 'assets')}/`)) {
					context.header('Cache-Control', 'public, max-age=31536000, immutable')
				}
			},
			precompressed: true,
			root: config.frontendDirectory,
		})
		app.get('*', staticFiles)
		app.get(
			'*',
			serveStatic({
				path: 'index.html',
				root: config.frontendDirectory,
			})
		)
	}

	app.onError((value, context) => {
		const error = asError(value)
		if (error instanceof HttpError) {
			const headers = new Headers(error.headers)
			headers.set('Content-Type', 'application/json; charset=UTF-8')
			return new Response(
				JSON.stringify(errorBody(error.code, error.message)),
				{
					headers,
					status: error.status,
				}
			)
		}
		logger.error('Unhandled request error', {
			error: error.message,
			method: context.req.method,
			path: context.req.path,
			requestId: context.get('requestId'),
		})
		return context.json(
			errorBody('internal_error', 'The server could not complete the request'),
			500
		)
	})

	app.notFound((context) =>
		context.json(errorBody('not_found', 'Route was not found'), 404)
	)

	return app
}

export const verifyFrontend = async (config: AppConfig): Promise<void> => {
	await access(join(config.frontendDirectory, 'index.html'))
}
