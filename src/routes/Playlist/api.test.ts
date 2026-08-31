import { expect, test } from 'bun:test'
import { TorrentApiClient } from './api'

test('current clients explicitly request background download and mark their app shell version', async () => {
	const observedRequests: Array<{
		body: unknown
		method: string
		version: string
	}> = []
	const client = new TorrentApiClient({
		fetcher: (_input, init) => {
			observedRequests.push({
				body: init?.body ? JSON.parse(String(init.body)) : null,
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
		{ body: null, method: 'GET', version: '2' },
		{
			body: {
				download: true,
				torrentId: '0123456789abcdef0123456789abcdef01234567',
			},
			method: 'POST',
			version: '2',
		},
	])
})

test('reads the non-blocking server torrent status', async () => {
	const observedUrls: string[] = []
	const client = new TorrentApiClient({
		fetcher: (input) => {
			observedUrls.push(String(input))
			return Promise.resolve(
				Response.json({
					downloadedBytes: 4096,
					downloadSpeed: 1024,
					infoHash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
					metadataReady: true,
					name: 'Example book',
					numPeers: 3,
					progress: 0.25,
					startedAt: '2026-08-31T12:00:00.000Z',
					state: 'downloading',
					totalBytes: 16_384,
				})
			)
		},
	})

	expect(
		await client.getTorrentStatus('ABCDEF0123456789ABCDEF0123456789ABCDEF01')
	).toEqual({
		downloadedBytes: 4096,
		downloadSpeed: 1024,
		infoHash: 'abcdef0123456789abcdef0123456789abcdef01',
		metadataReady: true,
		name: 'Example book',
		numPeers: 3,
		progress: 0.25,
		startedAt: '2026-08-31T12:00:00.000Z',
		state: 'downloading',
		totalBytes: 16_384,
	})
	expect(observedUrls).toEqual([
		'/api/torrents/abcdef0123456789abcdef0123456789abcdef01/status',
	])
})

test('treats an unknown status as unregistered without requesting torrent details', async () => {
	const observedUrls: string[] = []
	const client = new TorrentApiClient({
		fetcher: (input) => {
			observedUrls.push(String(input))
			return Promise.resolve(
				Response.json(
					{
						error: {
							code: 'torrent_not_found',
							message: 'Torrent was not found',
						},
					},
					{ status: 404 }
				)
			)
		},
	})

	expect(
		await client.getTorrentStatus('0123456789abcdef0123456789abcdef01234567')
	).toBeNull()
	expect(observedUrls).toEqual([
		'/api/torrents/0123456789abcdef0123456789abcdef01234567/status',
	])
})

test('reports an unavailable status route instead of treating it as an unregistered torrent', async () => {
	const client = new TorrentApiClient({
		fetcher: () =>
			Promise.resolve(
				Response.json(
					{
						error: {
							code: 'not_found',
							message: 'API route was not found',
						},
					},
					{ status: 404 }
				)
			),
	})

	await expect(
		client.getTorrentStatus('0123456789abcdef0123456789abcdef01234567')
	).rejects.toMatchObject({
		code: 'torrent_status_unavailable',
		status: 502,
	})
})

test('deletes a server torrent and surfaces structured deletion failures', async () => {
	const observedRequests: Array<{ method: string; url: string }> = []
	const responses = [
		new Response(null, { status: 204 }),
		Response.json(
			{
				error: {
					code: 'delete_failed',
					message: 'Unable to remove torrent data',
				},
			},
			{ status: 500 }
		),
	]
	const client = new TorrentApiClient({
		fetcher: (input, init) => {
			observedRequests.push({
				method: init?.method ?? 'GET',
				url: String(input),
			})
			const response = responses.shift()
			if (!response) {
				throw new Error('Unexpected deletion request')
			}
			return Promise.resolve(response)
		},
	})
	const infoHash = '0123456789abcdef0123456789abcdef01234567'

	expect(await client.deleteAvailableTorrent(infoHash)).toBe(true)
	await expect(client.deleteAvailableTorrent(infoHash)).rejects.toMatchObject({
		code: 'delete_failed',
		message: 'Unable to remove torrent data',
		status: 500,
	})
	expect(observedRequests).toEqual([
		{ method: 'DELETE', url: `/api/torrents/${infoHash}` },
		{ method: 'DELETE', url: `/api/torrents/${infoHash}` },
	])
})

test('preserves background download state in the available torrent list', async () => {
	const client = new TorrentApiClient({
		fetcher: () =>
			Promise.resolve(
				Response.json([
					{
						cachedBytes: 2048,
						downloadedBytes: 1024,
						downloadSpeed: 512,
						firstSeen: '2026-08-31T12:00:00.000Z',
						infoHash: '0123456789abcdef0123456789abcdef01234567',
						lastSeen: '2026-08-31T12:01:00.000Z',
						metadataReady: false,
						name: 'Torrent 0123456789abcdef0123456789abcdef01234567',
						numPeers: 2,
						progress: 0.125,
						state: 'fetching_metadata',
						totalBytes: 8192,
					},
				])
			),
	})

	const [torrent] = await client.getAvailableTorrents()
	expect(torrent).toMatchObject({
		cachedBytes: 2048,
		downloadedBytes: 1024,
		downloadSpeed: 512,
		infoHash: '0123456789abcdef0123456789abcdef01234567',
		metadataReady: false,
		numPeers: 2,
		progress: 0.125,
		state: 'fetching_metadata',
		totalBytes: 8192,
	})
	expect(torrent?.firstSeen).toEqual(new Date('2026-08-31T12:00:00.000Z'))
	expect(torrent?.lastSeen).toEqual(new Date('2026-08-31T12:01:00.000Z'))
})
