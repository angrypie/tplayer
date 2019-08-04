import Dexie from 'dexie'

const db = new Dexie('books_db')
db.version(1).stores({
	torrents: `ih`,
	files: `[ih+path]`,
})

async function addTorrent(ih, info) {
	await db.torrents.add({
		ih,
		info: JSON.stringify(info),
	})
}

async function getTorrent(ih) {
	const torrent = await db.torrents
		.where('ih')
		.equals(ih)
		.first()
	if (torrent === undefined) {
		return null
	}

	return {
		ih: torrent.ih,
		info: JSON.parse(torrent.info),
	}
}

async function addFile(ih, path, file) {
	await db.files.add({
		ih,
		path,
		file,
	})
}

async function getFile(ih, path) {
	const file = await db.files
		.where({ ih, path })
		.first()
	if (file === undefined) {
		return null
	}

	return file
}

export const store = {
	addTorrent,
	getTorrent,
	addFile,
	getFile,
}
