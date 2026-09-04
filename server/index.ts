import { serve } from 'bun'
import { createApp, verifyFrontend } from './app'
import { loadConfig } from './config'
import { AppDatabase } from './database'
import { asError } from './errors'
import { logger } from './logger'
import { TorrentManager } from './torrent/manager'
import { CouchSpeechProvider } from './transcription/couchSpeechProvider'
import { TranscriptionManager } from './transcription/manager'

const config = loadConfig()
if (config.serveFrontend) {
	await verifyFrontend(config)
}

const database = new AppDatabase(config.databasePath)
const manager = new TorrentManager({
	config: config.torrent,
	database,
	logger,
})
const transcriptions = new TranscriptionManager({
	config: config.transcription,
	database,
	logger,
	provider: new CouchSpeechProvider(),
	torrentManager: manager,
})
await transcriptions.start()
const app = createApp({
	config,
	database,
	logger,
	manager,
	serveFrontend: config.serveFrontend,
	transcriptions,
})

const server = serve({
	fetch: app.fetch,
	hostname: config.listen.hostname,
	idleTimeout: 0,
	maxRequestBodySize: 64 * 1024,
	port: config.listen.port,
})

logger.info('TPlayer server started', {
	cacheDirectory: config.torrent.cacheDirectory,
	databasePath: config.databasePath,
	hostname: server.hostname,
	port: server.port,
})

let stopping = false
const shutdown = async (signal: string): Promise<void> => {
	if (stopping) {
		return
	}
	stopping = true
	logger.info('TPlayer server stopping', { signal })
	server.stop(false)
	const forceTimer = setTimeout(() => {
		logger.error('Graceful shutdown timed out')
		process.exit(1)
	}, 10_000)
	try {
		await transcriptions.close()
		await manager.close()
		database.close()
		clearTimeout(forceTimer)
		logger.info('TPlayer server stopped')
		process.exit(0)
	} catch (value) {
		clearTimeout(forceTimer)
		logger.error('TPlayer shutdown failed', { error: asError(value).message })
		process.exit(1)
	}
}

process.once('SIGINT', async () => {
	await shutdown('SIGINT')
})
process.once('SIGTERM', async () => {
	await shutdown('SIGTERM')
})
