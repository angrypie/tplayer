import { decode } from '@thi.ng/bencode'
import { store } from './store'

export async function getTorrentInfo(ih) {
	const torrent = await store.getTorrent(ih)
	if (torrent !== null) {
		return torrent.info
	}
	const url = `/info?ih=${ih}`
	const res = await fetch(url, { mode: 'cors' })
	const body = await res.arrayBuffer()
	const info = decode(new Uint8Array(body))
	store.addTorrent(ih, info)
	return info
}

export async function getAudio(ih, pathArr) {
	try {
		const path = pathArr.join('/')
		const file = await store.getFile(ih, path)
		if (file !== null) {
			const audioUrl = URL.createObjectURL(file.file)
			return audioUrl
		}
		const url = `/data?ih=${ih}&path=${path}`
		const res = await fetch(url, { mode: 'cors' })
		const buf = await res.arrayBuffer()
		const array = new Uint8Array(buf)
		const blob = new Blob([array], { type: 'audio/mp3' })

		store.addFile(ih, path, blob)
		return URL.createObjectURL(blob)
	} catch (err) {
		console.error(err)
		return null
	}
}
