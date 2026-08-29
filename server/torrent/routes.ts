import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { TorrentManager } from './manager'

interface TorrentRoutesDependencies {
	manager: TorrentManager
}

interface RegisterTorrentBody {
	torrentId?: unknown
}

const contentDisposition = (name: string): string =>
	`inline; filename*=UTF-8''${encodeURIComponent(name)}`

const fileResponse = async (
	manager: TorrentManager,
	infoHash: string,
	fileId: string,
	request: Request
): Promise<Response> => {
	const opened = await manager.openFile(
		infoHash,
		fileId,
		request.headers.get('range') ?? undefined,
		request.signal
	)
	const headers = new Headers({
		'Accept-Ranges': 'bytes',
		'Cache-Control': 'private, no-store',
		'Content-Disposition': contentDisposition(opened.file.name),
		'Content-Length': String(opened.contentLength),
		'Content-Type': opened.file.mimeType,
		ETag: `"${infoHash}-${fileId}-${opened.file.length}"`,
		'X-Content-Type-Options': 'nosniff',
	})
	if (opened.range) {
		headers.set(
			'Content-Range',
			`bytes ${opened.range.start}-${opened.range.end}/${opened.file.length}`
		)
	}
	if (request.method === 'HEAD') {
		await opened.stream?.cancel()
		return new Response(null, {
			headers,
			status: opened.range ? 206 : 200,
		})
	}
	return new Response(opened.stream, {
		headers,
		status: opened.range ? 206 : 200,
	})
}

export const createTorrentRoutes = ({
	manager,
}: TorrentRoutesDependencies): Hono => {
	const routes = new Hono()
	routes.use(
		'/torrents',
		bodyLimit({
			maxSize: 16 * 1024,
			onError: (context) =>
				context.json(
					{
						error: {
							code: 'body_too_large',
							message: 'Request body exceeds 16 KiB',
						},
					},
					413
				),
		})
	)

	routes.get('/torrents', (context) => context.json(manager.list()))

	routes.post('/torrents', async (context) => {
		let body: RegisterTorrentBody
		try {
			body = await context.req.json<RegisterTorrentBody>()
		} catch {
			return context.json(
				{
					error: {
						code: 'invalid_json',
						message: 'Request body must be valid JSON',
					},
				},
				400
			)
		}
		if (typeof body.torrentId !== 'string') {
			return context.json(
				{
					error: {
						code: 'invalid_torrent',
						message: 'torrentId must be a magnet URI or info hash',
					},
				},
				422
			)
		}
		return context.json(manager.register(body.torrentId), 202)
	})

	routes.get('/torrents/:infoHash', async (context) => {
		const details = await manager.details(
			context.req.param('infoHash'),
			context.req.raw.signal
		)
		return context.json(details)
	})

	routes.delete('/torrents/:infoHash', async (context) => {
		const removed = await manager.remove(context.req.param('infoHash'))
		if (!removed) {
			return context.json(
				{
					error: {
						code: 'torrent_not_found',
						message: 'Torrent was not found',
					},
				},
				404
			)
		}
		return new Response(null, { status: 204 })
	})

	routes.get('/torrents/:infoHash/files/:fileId', async (context) =>
		fileResponse(
			manager,
			context.req.param('infoHash'),
			context.req.param('fileId'),
			context.req.raw
		)
	)

	routes.post('/torrents/:infoHash/preload', (context) =>
		context.json(manager.startPreload(context.req.param('infoHash')), 202)
	)

	routes.get('/torrents/:infoHash/preload', (context) => {
		const status = manager.preloadStatus(context.req.param('infoHash'))
		if (!status) {
			return context.json(
				{
					error: {
						code: 'preload_not_found',
						message: 'No preload job exists for this torrent',
					},
				},
				404
			)
		}
		return context.json(status)
	})

	return routes
}

export { fileResponse }
