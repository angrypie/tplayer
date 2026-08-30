import { expect, test } from 'bun:test'
import { TorrentApiClient } from './api'

test('current clients mark list and registration requests with their app shell version', async () => {
	const observedRequests: Array<{ method: string; version: string }> = []
	const client = new TorrentApiClient({
		fetcher: (_input, init) => {
			observedRequests.push({
				method: init?.method ?? 'GET',
				version: new Headers(init?.headers).get('X-TPlayer-App-Shell') ?? '',
			})
			return Promise.resolve(
				init?.method === 'POST'
					? Response.json({
							infoHash: '0123456789abcdef0123456789abcdef01234567',
							metadataReady: true,
						})
					: Response.json([])
			)
		},
	})

	expect(await client.getAvailableTorrents()).toEqual([])
	expect(
		await client.registerTorrent('0123456789abcdef0123456789abcdef01234567')
	).toEqual({
		infoHash: '0123456789abcdef0123456789abcdef01234567',
		metadataReady: true,
	})
	expect(observedRequests).toEqual([
		{ method: 'GET', version: '2' },
		{ method: 'POST', version: '2' },
	])
})
