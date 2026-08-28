import { runInAction, toJS } from 'mobx'
import { useLocalObservable } from 'mobx-react-lite'
import natsort from 'natsort'
import React from 'react'
import { storage } from '~/storage'
import { comparePath } from '~/utils'
import { getAudio, getTorrentInfo } from './api'
import { usePlayerStore } from './Player/store'

export const COMBINED_FILES_PREFIX = 'combined_Joh1thoh'
const MAX_COMBINED_FILE_SIZE = 100 * 1024 * 1024

const getConsecutiveCachedGroups = (files) => {
	const groups = []
	let currentGroup = []

	for (const file of files) {
		if (file.cached) {
			currentGroup.push(file)
			continue
		}
		if (currentGroup.length > 1) {
			groups.push(currentGroup)
		}
		currentGroup = []
	}

	if (currentGroup.length > 1) {
		groups.push(currentGroup)
	}
	return groups
}

const splitGroupBySize = (files) => {
	const groups = []
	let currentGroup = []
	let currentSize = 0

	for (const file of files) {
		const exceedsLimit =
			currentSize + file.length > MAX_COMBINED_FILE_SIZE &&
			currentGroup.length > 0
		if (exceedsLimit) {
			if (currentGroup.length > 1) {
				groups.push(currentGroup)
			}
			currentGroup = [file]
			currentSize = file.length
			continue
		}
		currentGroup.push(file)
		currentSize += file.length
	}

	if (currentGroup.length > 1) {
		groups.push(currentGroup)
	}
	return groups
}

const loadStoredBlobs = async (infoHash, files) => {
	const storedFiles = await Promise.all(
		files.map((file) => storage.getFile(infoHash, file.path.join('/')))
	)
	if (storedFiles.some((file) => !file)) {
		return null
	}
	return storedFiles.map(({ file }) => file)
}

const prepareCombinedFile = async (infoHash, torrentFiles, files) => {
	const blobs = await loadStoredBlobs(infoHash, files)
	if (!blobs) {
		return null
	}
	const combinedBlob = await concatMP3Blobs(blobs)
	if (combinedBlob.size > MAX_COMBINED_FILE_SIZE) {
		return { exceedsLimit: true }
	}

	const [firstFile] = files
	const firstIndex = torrentFiles.findIndex(
		(file) => file.path.join('/') === firstFile.path.join('/')
	)
	const rangePrefix = `${COMBINED_FILES_PREFIX}/${firstIndex}-${firstIndex + files.length - 1}/`
	return {
		blob: combinedBlob,
		exceedsLimit: false,
		originalPaths: files.map((file) => file.path.join('/')),
		path: `${rangePrefix}${firstFile.path.join('/')}`,
	}
}

const saveCombinedFile = async (infoHash, combinedFile) => {
	await storage.addFile(infoHash, combinedFile.path, combinedFile.blob)
	await Promise.all(
		combinedFile.originalPaths.map((path) => storage.removeFile(infoHash, path))
	)
}

const collectStoredFileState = (files, torrentFiles) => {
	const storedPaths = new Set()
	const hiddenFiles = new Set()
	const allFiles = []

	for (const file of files) {
		const pathParts = file.path.split('/')
		if (pathParts[0] !== COMBINED_FILES_PREFIX) {
			storedPaths.add(file.path)
			allFiles.push({
				cached: true,
				length: file.file.size,
				path: pathParts,
				state: 'ready',
			})
			continue
		}

		const [startIndex, endIndex] = pathParts[1].split('-').map(Number)
		for (let index = startIndex; index <= endIndex; index += 1) {
			const originalFile = torrentFiles[index]
			if (originalFile) {
				hiddenFiles.add(originalFile.path.join('/'))
			}
		}
		storedPaths.add(file.path)
		allFiles.push({
			cached: true,
			isCombined: true,
			length: file.file.size,
			originalIndexes: [startIndex, endIndex],
			path: pathParts,
			state: 'ready',
		})
	}

	return { allFiles, hiddenFiles, storedPaths }
}

export const useBookStores = ({ ih }) => {
	const playerStore = usePlayerStore()
	const bookStore = useBookStore({ ih, playerStore })
	return {
		bookStore,
		playerStore,
	}
}

export const useBookStore = ({ ih: initialInfoHash, playerStore }) => {
	const store = useLocalObservable(() => ({
		audio: null,

		async cleanBookData(infoHash) {
			const result = await storage.removeFilesByIh(infoHash)
			if (result) {
				await store.setTorrentInfo(infoHash)
			}
		},

		async concatAllFiles() {
			const { ih: infoHash, torrentInfo } = store
			if (!(infoHash && torrentInfo.files.length)) {
				return false
			}

			const groups = getConsecutiveCachedGroups(torrentInfo.files).flatMap(
				splitGroupBySize
			)
			if (groups.length === 0) {
				return false
			}

			for (const group of groups) {
				// biome-ignore lint/performance/noAwaitInLoops: Preparing one group at a time bounds retained audio data to one combined file.
				const combinedFile = await prepareCombinedFile(
					infoHash,
					torrentInfo.files,
					group
				)
				if (combinedFile === null) {
					return false
				}
				if (combinedFile.exceedsLimit) {
					store.setNotice('Combined file would exceed 100MB limit')
					return false
				}

				await saveCombinedFile(infoHash, combinedFile)
			}
			await store.setTorrentInfo(infoHash)
			return true
		},

		continueLastPlayed(file, state) {
			store.setCurrentFile(file, state)
		},
		currentFile: { path: [] },

		async downloadAllFiles() {
			const { ih: infoHash, torrentInfo } = store
			if (!(infoHash && torrentInfo.files.length)) {
				return false
			}

			// Get list of non-cached files
			const filesToDownload = torrentInfo.files.filter((file) => !file.cached)
			if (filesToDownload.length === 0) {
				return true // All files already downloaded
			}

			let downloadedCount = 0
			for (const file of filesToDownload) {
				try {
					file.state = 'loading'
					// biome-ignore lint/performance/noAwaitInLoops: Downloads are sequential to bound network and in-memory audio data.
					const url = await store.getAudio(file)
					if (url !== null) {
						URL.revokeObjectURL(url)
						downloadedCount += 1
					}
				} catch (error) {
					console.error('Failed to download file:', file.path.join('/'), error)
				}
			}

			return downloadedCount === filesToDownload.length
		},

		//all files in metadata plus from storage merged into one array
		async getAllTorrentFiles() {
			const files = await storage.getAllFilesForTorrent(store.ih)
			const { allFiles, hiddenFiles, storedPaths } = collectStoredFileState(
				files,
				store.torrentInfo.files
			)

			// Add files from torrent metadata that weren't combined or stored
			for (const file of store.torrentInfo.files) {
				const filePath = file.path.join('/')
				if (!(storedPaths.has(filePath) || hiddenFiles.has(filePath))) {
					allFiles.push(file)
				}
			}

			return allFiles
		},

		async getAudio({ path }) {
			const { ih: infoHash } = store
			if (infoHash === undefined || path === undefined || path.length <= 0) {
				return null
			}
			const url = await getAudio(infoHash, path)
			if (url !== null) {
				store.updateCached({ path }, true)
			}
			return url
		},

		async getNextFile() {
			const files = await store.getAllTorrentFiles()
			const currentPath = store.currentFile.path
			const currentIndex = files.findIndex(({ path }) =>
				comparePath(path, currentPath)
			)
			return files[currentIndex + 1]
		},
		ih: initialInfoHash,
		notice: null,
		playerStore,

		async removeBook(infoHash) {
			const result = await storage.removeFilesAndTorrent(infoHash)
			return result
		},

		async removeFile(infoHash, file) {
			const success = await storage.removeFile(infoHash, file.path.join('/'))
			if (success) {
				runInAction(() => {
					file.cached = false
					file.state = 'ready'
				})
			}
			return success
		},

		async saveCurrentPlaying() {
			const { currentFile, ih: infoHash } = store
			const { playing, getProgress } = store.playerStore
			if (!playing) {
				return
			}
			await storage.updateTorrent(infoHash, {
				state: {
					path: toJS(currentFile.path),
					time: getProgress(),
					updatedAt: Date.now(),
				},
			})
		},
		//set current file to play, and seek to last played position if state provided
		async setCurrentFile(file, state) {
			if (typeof file !== 'object') {
				return
			}
			if (file.cached === true) {
				store.currentFile = file
				if (state !== undefined) {
					setTimeout(() => {
						store.playerStore.seekTo(state.time - 5)
					}, 200)
				}
				return true
			}
			file.state = 'loading'
			const url = await store.getAudio(file)
			if (url === null) {
				file.state = ''
				store.setNotice('File is not available')
			}
			return false
		},

		setNotice(message) {
			store.notice = message
		},

		async setTorrentInfo(infoHash) {
			const info = await getTorrentInfo(infoHash)
			const { name = '', files = [], length = 0, state } = info
			files.sort((a, b) => natsort()(a.path.join('/'), b.path.join('/')))
			store.updateTorrentInfo({
				files,
				length,
				name: info['name.utf-8'] || name,
				state,
			})
			// Start play
			if (state) {
				for (const file of files) {
					if (comparePath(file.path, state.path)) {
						store.continueLastPlayed(file, state)
					}
				}
			}
		},
		torrentInfo: { files: [], length: 0, name: '' },

		updateCached({ path }, cached) {
			const file = store.torrentInfo.files.find(({ path: p }) =>
				comparePath(path, p)
			)
			if (file) {
				file.cached = cached
				file.state = 'ready'
			}
		},

		updateTorrentInfo(torrentInfo) {
			store.torrentInfo = torrentInfo
		},
	}))

	store.playerStore.player.onEnd = async () => {
		const nextFile = await store.getNextFile()
		const ok = await store.setCurrentFile(nextFile)
		if (!ok) {
			store.setCurrentFile(nextFile)
		}
	}

	//TODO memory leak, need to clean interval on every interval creation
	React.useEffect(() => {
		const interval = setInterval(store.saveCurrentPlaying, 3000)
		return () => clearInterval(interval)
	}, [store])

	return store
}

function isMP3(buffer) {
	// Check for ID3v2 header
	if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
		// "ID3"
		return true
	}

	// Check for MPEG sync word (0xFF followed by 0xE0, 0xF0, or 0xF2)
	// biome-ignore lint/suspicious/noBitwiseOperators: MPEG frame sync detection requires a byte mask.
	if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
		return true
	}

	return false
}
// NOTE this is exerimental feature to try to connect tiny MP3 files, it would not work properly in most cases.
// Using standart API leads to poor performance, so we stuck with manual file concatenation.
// Maybe find more optimal solution like using ffmpeg.wasm
async function concatMP3Blobs(blobs) {
	if (!blobs || blobs.length === 0) {
		return new Blob([], { type: 'audio/mpeg' }) // Return an empty MP3 blob if no blobs are provided
	}

	const buffers = await Promise.all(
		blobs.map(async (blob) => new Uint8Array(await blob.arrayBuffer()))
	)
	const audioBuffers = buffers.filter(isMP3)

	// Calculate the total size of the combined audio data
	let totalLength = 0
	for (const buffer of audioBuffers) {
		totalLength += buffer.length
	}

	// Create a new Uint8Array to hold the combined data
	const combinedBuffer = new Uint8Array(totalLength)

	// Copy the data from each individual buffer into the combined buffer
	let offset = 0
	for (const buffer of audioBuffers) {
		combinedBuffer.set(buffer, offset)
		offset += buffer.length
	}

	// Verify the combined file is still a valid MP3
	if (!isMP3(combinedBuffer)) {
		throw new Error('Combined file is not a valid MP3')
	}

	// Create a new Blob from the combined buffer
	return new Blob([combinedBuffer], { type: 'audio/mpeg' })
}
