import { storage } from '~/storage'
import bencode from 'bencode'

export async function getTorrentInfo(ih) {
	const torrent = await storage.getTorrent(ih)
	if (torrent !== null) {
		return await transformTorrentInfo(ih, torrent.info, torrent.state)
	}
	const url = `/api/info?ih=${ih}`
	const res = await fetch(url, { mode: 'cors' })
	const body = await res.arrayBuffer()
	const info = bencode.decode(body, 'utf-8')
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
		const url = `/api/data?ih=${ih}&path=${path}`
		const res = await fetch(url, { mode: 'cors' })
		if (!res.ok) {
			throw new Error(res.statusText)
		}
		const buf = await res.arrayBuffer()
		const array = new Uint8Array(buf)
		const blob = new Blob([array], { type: 'audio/mpeg' })

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

export async function getAvailableTorrents() {
	try {
		const response = await fetch('/api/torrents', { mode: 'cors' });
		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}
		const torrents = await response.json();
		//check if torrents is an array
		if (!Array.isArray(torrents)) {
			console.error('torrents is not an array');
			return [];
		}
		return torrents.map(torrent => ({
			name: torrent.name,
			infoHash: torrent.info_hash,
			lastSeen: new Date(torrent.last_seen),
			firstSeen: new Date(torrent.first_seen),
		}));
	} catch (error) {
		console.error('Error fetching available torrents:', error);
		return [];
	}
}

export async function deleteAvailableTorrent(infoHash) {
	try {
		const response = await fetch(`/api/torrents/${encodeURIComponent(infoHash)}`, {
			method: 'DELETE',
			mode: 'cors',
		});
		if (!response.ok) {
			const data = await response.json().catch(() => ({}));
			throw new Error(data.error || `HTTP error! status: ${response.status}`);
		}
		return true;
	} catch (error) {
		console.error('Error deleting available torrent:', error);
		return false;
	}
}

export async function preloadTorrent(ih) {
	try {
		const url = `/api/preload?ih=${ih}`
		const res = await fetch(url, { mode: 'cors' })
		const data = await res.json()
		if (!res.ok) {
			throw new Error(data.error || res.statusText)
		}
		return data.status
	} catch (err) {
		console.error('Failed to preload torrent:', err)
		throw err
	}
}
