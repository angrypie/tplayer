import { describe, expect, test } from 'bun:test'
import WebTorrent, { type Torrent } from 'webtorrent'
import { parseTorrentReference } from './reference'

const IDENTIFIER_TIMEOUT_MS = 2000
const INFO_HASH = '0123456789abcdef0123456789abcdef01234567'

const createParserClient = (): WebTorrent =>
	new WebTorrent({
		dht: false,
		lsd: false,
		natPmp: false,
		natUpnp: false,
		torrentPort: 0,
		tracker: false,
		utPex: false,
		utp: false,
	})

const destroyClient = async (client: WebTorrent): Promise<void> => {
	if (client.destroyed) {
		return
	}
	await new Promise<void>((resolve, reject) => {
		client.destroy((error) => {
			if (error) {
				reject(error)
				return
			}
			resolve()
		})
	})
}

const waitForInfoHash = async (torrent: Torrent): Promise<void> => {
	if (torrent.infoHash === INFO_HASH) {
		return
	}
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup()
			reject(
				new Error('WebTorrent did not accept the sanitized magnet in time')
			)
		}, IDENTIFIER_TIMEOUT_MS)
		const onInfoHash = (): void => {
			cleanup()
			resolve()
		}
		const onError = (error: Error | string): void => {
			cleanup()
			reject(error instanceof Error ? error : new Error(error))
		}
		const cleanup = (): void => {
			clearTimeout(timeout)
			torrent.off('infoHash', onInfoHash)
			torrent.off('error', onError)
		}
		torrent.once('infoHash', onInfoHash)
		torrent.once('error', onError)
	})
}

describe('torrent reference compatibility', () => {
	test('keeps encoded display and tracker data WebTorrent-readable while removing alternate metadata URLs', async () => {
		const displayName = 'Encoded & playable audiobook'
		const tracker = 'https://tracker.example.test/announce?passkey=a+b/c'
		const unsafeExactSource =
			'https://metadata.example.test/exact.torrent?token=secret'
		const unsafeAcceptableSource =
			'https://metadata.example.test/fallback.torrent?token=secret'
		const source = [
			`magnet:?xt=urn:btih:${INFO_HASH}`,
			`dn=${encodeURIComponent(displayName)}`,
			`tr=${encodeURIComponent(tracker)}`,
			`xs=${encodeURIComponent(unsafeExactSource)}`,
			`as=${encodeURIComponent(unsafeAcceptableSource)}`,
		].join('&')
		const reference = parseTorrentReference(source)
		const sanitized = new URL(reference.torrentId)
		expect(reference.infoHash).toBe(INFO_HASH)
		expect(sanitized.searchParams.get('xt')).toBe(`urn:btih:${INFO_HASH}`)
		expect(sanitized.searchParams.get('dn')).toBe(displayName)
		expect(sanitized.searchParams.getAll('tr')).toEqual([tracker])
		expect(sanitized.searchParams.has('xs')).toBe(false)
		expect(sanitized.searchParams.has('as')).toBe(false)

		const client = createParserClient()
		try {
			const torrent = client.add(reference.torrentId, { deselect: true })
			await waitForInfoHash(torrent)
			expect(torrent.infoHash).toBe(INFO_HASH)
			expect(torrent.name).toBe(displayName)
			expect(torrent.announce).toContain(tracker)
		} finally {
			await destroyClient(client)
		}
	})
})
