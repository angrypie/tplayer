import Dexie from 'dexie'

const db = new Dexie('books')
db.version(2).stores({
	torrents: `ih`,
	files: `[ih+path]`,
	notes: `++id, ih`, //notes attached to specific file
})

async function addTorrent(ih, info) {
	await db.torrents.add({
		ih,
		info: JSON.stringify(info),
		state: { path: [], time: 0 },
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
		state: torrent.state,
	}
}

async function getTorrents(limit = 5) {
	const torrents = await db.torrents.limit(limit).toArray()
	return torrents.map(({ ih, info, state }) => ({
		ih,
		info: JSON.parse(info),
		state,
	}))
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

async function getAllFilesForTorrent(ih) {
	const files = await db.files.where('ih').equals(ih).toArray()
	return files
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
		await db.files.where('ih').equals(ih).delete()
		return true
	} catch (err) {
		alert('removing file error: ' + JSON.stringify(err))
		return false
	}
}

async function removeFilesAndTorrent(ih) {
	try {
		await removeFilesByIh(ih)
		await db.torrents.where('ih').equals(ih).delete()
		return true
	} catch (err) {
		alert('removing files and torernt error: ' + JSON.stringify(err))
		return false
	}
}

async function updateTorrent(ih, data) {
	try {
		return await db.torrents.update(ih, data)
	} catch (err) {
		console.log(err)
	}
}

async function addNote(ih, path, time, note) {
	await db.notes.add({ ih, path, time, note });
}

async function getNote(id) {
	const note = await db.notes.get(id)
	return note
}

async function getAllNotes(ih) {
	const allNotes = await db.notes.where('ih').equals(ih).toArray();
	return allNotes;
}


async function removeNote(id) {
	await db.notes.where({ id }).delete()
}


export const storage = {
	addTorrent,
	getTorrent,
	addFile,
	getFile,
	removeFile,
	removeFilesByIh,
	removeFilesAndTorrent,
	getTorrents,
	updateTorrent,
	addNote,
	getNote,
	getAllNotes,
	removeNote,
	getAllFilesForTorrent
}
