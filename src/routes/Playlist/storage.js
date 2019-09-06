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
	const file = await db.files.where({ ih, path }).first()
	if (file === undefined) {
		return null
	}

	return file
}

async function removeFile(ih, path) {
	try {
		await db.files.where({ ih, path }).delete()
		return true
	} catch (err) {
		alert('removing file error: ' + JSON.stringify(err))
		return false
	}
}

async function removeFilesByIh(ih) {
	try {
		await db.files
			.where('[ih+path]')
			.between([ih, Dexie.minKey], [ih, Dexie.maxKey])
			.delete()
		return true
	} catch (err) {
		alert('removing file error: ' + JSON.stringify(err))
		return false
	}
}

export const storage = {
	addTorrent,
	getTorrent,
	addFile,
	getFile,
	removeFile,
	removeFilesByIh,
}
