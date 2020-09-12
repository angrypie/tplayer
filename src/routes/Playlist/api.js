import { storage } from '~/storage'
import bencode from 'bencode'

export async function getTorrentInfo(ih) {
	const torrent = await storage.getTorrent(ih)
	if (torrent !== null) {
		return await transformTorrentInfo(ih, torrent.info, torrent.state)
	}
	const url = `/info?ih=${ih}`
	const res = await fetch(url, { mode: 'cors' })
	const body = await res.arrayBuffer()
	const info = bencode.decode(body, 'utf8')
	storage.addTorrent(ih, info)
	return await transformTorrentInfo(ih, info)
}

export async function getAudio(ih, pathArr) {
	try {
		const path = pathArr.join('/')
		const file = await storage.getFile(ih, path)
		if (file !== null) {
			const audioUrl = URL.createObjectURL(file.file)
			return audioUrl
		}
		const url = `/data?ih=${ih}&path=${path}`
		const res = await fetch(url, { mode: 'cors' })
		if (!res.ok) {
			throw new Error(res.statusText)
		}
		const buf = await res.arrayBuffer()
		const array = new Uint8Array(buf)
		const blob = new Blob([array], { type: 'audio/mp3' })

		storage.addFile(ih, path, blob)
		return URL.createObjectURL(blob)
	} catch (err) {
		console.error(err)
		return null
	}
}

async function transformTorrentInfo(ih, torrent, state) {
	if (!torrent.files) {
		const { length, name } = torrent
		torrent.files = [{ name, length, path: [name] }]
	}
	for (const file of torrent.files) {
		const cached = await storage.getFile(ih, file.path.join('/'))
		file.cached = cached !== null
		file.state = 'ready'
	}
	return { ...torrent, state }
}
