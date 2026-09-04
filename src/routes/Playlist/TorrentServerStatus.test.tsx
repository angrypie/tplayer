import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TorrentServerStatus as TorrentServerStatusDto } from './api'
import {
	TORRENT_SERVER_STATUS_PANEL_ID,
	TorrentServerStatus,
	torrentServerStatusCopy,
} from './TorrentServerStatus'

const idleStatus = (
	overrides: Partial<TorrentServerStatusDto> = {}
): TorrentServerStatusDto => ({
	downloadedBytes: 0,
	downloadSpeed: 0,
	infoHash: '0123456789abcdef0123456789abcdef01234567',
	metadataReady: true,
	name: 'Example audiobook',
	numPeers: 0,
	progress: 0,
	state: 'idle',
	totalBytes: 1000,
	...overrides,
})

const doNothing = (): void => undefined

describe('torrent server status', () => {
	test('explains retained partial bytes when the background download is idle', () => {
		const copy = torrentServerStatusCopy(
			'registered',
			idleStatus({ downloadedBytes: 400, progress: 0.4 })
		)

		expect(copy.title).toBe('Not downloading on the server')
		expect(copy.description).toContain('40%')
		expect(copy.description).toContain('background download is not running')
		expect(copy.description).toContain('fetch the remaining chapters')
		expect(copy.description).toContain(
			'A chapter can be transcribed once it is fully available on the server'
		)
	})

	test('keeps the server download panel addressable from caption prerequisites', () => {
		const markup = renderToStaticMarkup(
			<TorrentServerStatus
				onAction={doNothing}
				onRetry={doNothing}
				phase='registered'
				serverAccessAllowed
				status={idleStatus()}
			/>
		)

		expect(markup).toContain(`id="${TORRENT_SERVER_STATUS_PANEL_ID}"`)
		expect(markup).toContain('Not downloading on the server')
	})
})
