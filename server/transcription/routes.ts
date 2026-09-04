import {
	CAPTION_FILE_EXTENSION,
	CAPTION_MIME_TYPE,
} from '@tplayer/captions/codec'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { TranscriptionManager } from './manager'
import { artifactEtag } from './manager'

interface TranscriptionRoutesDependencies {
	transcriptions: TranscriptionManager
}

interface TranscriptionSettingsBody {
	automaticTranscription?: unknown
}

const errorBody = (code: string, message: string): object => ({
	error: { code, message },
})

const noJob = (): Response =>
	Response.json(
		errorBody('transcription_not_found', 'No transcription job was found'),
		{ status: 404 }
	)

const ifNoneMatchIncludes = (
	header: string | undefined,
	etag: string
): boolean =>
	header?.split(',').some((candidate) => {
		const trimmed = candidate.trim()
		if (trimmed === '*') {
			return true
		}
		return (
			(trimmed.startsWith('W/') ? trimmed.slice(2).trim() : trimmed) === etag
		)
	}) ?? false

export const createTranscriptionRoutes = ({
	transcriptions,
}: TranscriptionRoutesDependencies): Hono => {
	const routes = new Hono()
	routes.use(
		'/settings/transcription',
		bodyLimit({
			maxSize: 1024,
			onError: (context) =>
				context.json(
					errorBody('body_too_large', 'Request body exceeds 1 KiB'),
					413
				),
		})
	)

	routes.get('/settings/transcription', (context) =>
		context.json(transcriptions.getAutomaticTranscriptionSetting())
	)

	routes.put('/settings/transcription', async (context) => {
		let body: TranscriptionSettingsBody
		try {
			body = await context.req.json<TranscriptionSettingsBody>()
		} catch {
			return context.json(
				errorBody('invalid_json', 'Request body must be valid JSON'),
				400
			)
		}
		if (typeof body.automaticTranscription !== 'boolean') {
			return context.json(
				errorBody(
					'invalid_transcription_setting',
					'automaticTranscription must be a boolean'
				),
				422
			)
		}
		const setting = await transcriptions.setAutomaticTranscriptionEnabled(
			body.automaticTranscription
		)
		return context.json(setting, setting.cleanupPending ? 202 : 200)
	})

	routes.post('/torrents/:infoHash/transcriptions', async (context) =>
		context.json(
			await transcriptions.queueTorrent(
				context.req.param('infoHash'),
				'manual',
				context.req.raw.signal
			),
			202
		)
	)

	routes.get('/torrents/:infoHash/transcriptions', (context) =>
		context.json(transcriptions.list(context.req.param('infoHash')))
	)

	routes.delete('/torrents/:infoHash/transcriptions', async (context) => {
		await transcriptions.cancelTorrent(context.req.param('infoHash'), true)
		return new Response(null, { status: 204 })
	})

	routes.post(
		'/torrents/:infoHash/files/:fileId/transcription',
		async (context) =>
			context.json(
				await transcriptions.queueFile(
					context.req.param('infoHash'),
					context.req.param('fileId'),
					'manual',
					context.req.raw.signal
				),
				202
			)
	)

	routes.get('/torrents/:infoHash/files/:fileId/transcription', (context) => {
		const status = transcriptions.get(
			context.req.param('infoHash'),
			context.req.param('fileId')
		)
		return status ? context.json(status) : noJob()
	})

	routes.delete(
		'/torrents/:infoHash/files/:fileId/transcription',
		async (context) => {
			const removed = await transcriptions.cancelFile(
				context.req.param('infoHash'),
				context.req.param('fileId')
			)
			return removed ? new Response(null, { status: 204 }) : noJob()
		}
	)

	routes.get('/torrents/:infoHash/files/:fileId/captions', (context) => {
		const artifact = transcriptions.getArtifact(
			context.req.param('infoHash'),
			context.req.param('fileId')
		)
		if (!artifact) {
			return context.json(
				errorBody('captions_not_found', 'Generated captions were not found'),
				404
			)
		}
		const etag = artifactEtag(artifact)
		const headers = new Headers({
			'Cache-Control': 'private, max-age=0, must-revalidate',
			'Content-Disposition': `inline; filename="captions.${CAPTION_FILE_EXTENSION}"`,
			'Content-Length': String(artifact.bytes.byteLength),
			'Content-Type': `${CAPTION_MIME_TYPE}; version=${artifact.formatVersion}`,
			ETag: etag,
			'X-Content-Type-Options': 'nosniff',
			'X-TPlayer-Caption-Updated-At': artifact.updatedAt,
			'X-TPlayer-Caption-Version': String(artifact.formatVersion),
		})
		if (ifNoneMatchIncludes(context.req.header('If-None-Match'), etag)) {
			headers.delete('Content-Length')
			return new Response(null, { headers, status: 304 })
		}
		return new Response(artifact.bytes.slice().buffer, { headers })
	})

	return routes
}
