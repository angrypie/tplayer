import { useLocalObservable } from 'mobx-react-lite'
import { getTorrentInfo, getAudio } from './api'
import { usePlayerStore } from './Player/store'
import { storage } from '~/storage'
import { toJS } from 'mobx'
import { comparePath } from '~/utils'
import natsort from 'natsort'
import React from 'react'
import { runInAction } from 'mobx'

export const COMBINED_FILES_PREFIX = 'combined_Joh1thoh'

export const useBookStores = ({ ih }) => {
	const playerStore = usePlayerStore()
	const bookStore = useBookStore({ ih, playerStore })
	return {
		bookStore,
		playerStore,
	}
}

export const useBookStore = ({ ih, playerStore }) => {
	const store = useLocalObservable(() => ({
		playerStore: playerStore,
		ih,
		audio: null,
		torrentInfo: { name: '', files: [], length: 0 },
		currentFile: { path: [] },

		async getNextFile() {
			const files = await store.getAllTorrentFiles()
			const currentPath = store.currentFile.path
			const currentIndex = files.findIndex(({ path }) =>
				comparePath(path, currentPath)
			)
			return files[currentIndex + 1]
		},

		async saveCurrentPlaying() {
			const { ih, currentFile } = store
			const { playing, getProgress } = store.playerStore
			if (!playing) {
				return
			}
			storage.updateTorrent(
				ih,
				{
					state: {
						path: toJS(currentFile.path),
						time: getProgress(),
						updatedAt: new Date().valueOf(),
					},
				}
			)
		},
		//set current file to play, and seek to last played position if state provided
		async setCurrentFile(file, state = undefined) {
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
				alert('File is not available')
			}
			return false
		},

		updateTorrentInfo(torrentInfo) {
			store.torrentInfo = torrentInfo
		},

		//all files in metadata plus from storage merged into one array
		async getAllTorrentFiles() {
			const files = await storage.getAllFilesForTorrent(ih)

			const storedPath = {}
			const allFiles = []
			const hiddenFiles = new Set() // Track files that were combined

			// First pass: process combined files and collect hidden files
			for (let file of files) {
				const pathParts = file.path.split('/')
				if (pathParts[0] === COMBINED_FILES_PREFIX) {
					const [startIdx, endIdx] = pathParts[1].split('-').map(Number)
					// Add original files to hidden set
					for (let i = startIdx; i <= endIdx; i++) {
						const originalFile = store.torrentInfo.files[i]
						if (originalFile) {
							hiddenFiles.add(originalFile.path.join('/'))
						}
					}
					storedPath[file.path] = true
					allFiles.push({
						path: file.path.split('/'),
						length: file.file.size,
						cached: true,
						state: 'ready',
						isCombined: true,
						originalIndexes: [startIdx, endIdx]
					})
				} else {
					storedPath[file.path] = true
					allFiles.push({
						path: file.path.split('/'),
						length: file.file.size,
						cached: true,
						state: 'ready'
					})
				}
			}

			// Add files from torrent metadata that weren't combined or stored
			for (let file of store.torrentInfo.files) {
				const filePath = file.path.join('/')
				if (!storedPath[filePath] && !hiddenFiles.has(filePath)) {
					allFiles.push(file)
				}
			}

			return allFiles
		},

		async setTorrentInfo(ih) {
			const info = await getTorrentInfo(ih)
			const { name = '', files = [], length = 0, state } = info
			files.sort((a, b) => natsort()(a.path.join('/'), b.path.join('/')))
			store.updateTorrentInfo({
				name: info['name.utf-8'] || name,
				files,
				length,
				state,
			})
			// Start play
			if (state) {
				files.forEach((file) => {
					if (comparePath(file.path, state.path)) {
						store.continueLastPlayed(file, state)
					}
				})
			}
		},

		continueLastPlayed(file, state) {
			store.setCurrentFile(file, state)
		},

		updateCached({ path }, cached) {
			const file = store.torrentInfo.files.find(({ path: p }) =>
				comparePath(path, p)
			)
			if (file) {
				file.cached = cached
				file.state = 'ready'
			}
		},

		async getAudio({ path }) {
			const { ih } = store
			if (ih === undefined || path === undefined || path.length <= 0) {
				return null
			}
			const url = await getAudio(ih, path)
			if (url !== null) {
				store.updateCached({ path }, true)
			}
			return url
		},

		async cleanBookData(ih) {
			const result = await storage.removeFilesByIh(ih)
			if (result) {
				store.setTorrentInfo(ih)
			}
		},

		async removeBook(ih) {
			const result = await storage.removeFilesAndTorrent(ih)
			return result
		},

		async removeFile(ih, file) {
			const success = await storage.removeFile(ih, file.path.join('/'))
			if (success) {
				runInAction(() => {
					file.cached = false
					file.state = 'ready'
				})
			}
			return success
		},

		async downloadAllFiles() {
			const { ih, torrentInfo } = store
			if (!ih || !torrentInfo.files.length) {
				return false
			}

			// Get list of non-cached files
			const filesToDownload = torrentInfo.files.filter(file => !file.cached)
			if (filesToDownload.length === 0) {
				return true // All files already downloaded
			}

			// Download each file
			let downloadedCount = 0
			for (const file of filesToDownload) {
				try {
					file.state = 'loading'
					const url = await store.getAudio(file)
					if (url !== null) {
						downloadedCount++
					}
				} catch (err) {
					console.error('Failed to download file:', file.path.join('/'), err)
				}
			}

			return downloadedCount === filesToDownload.length
		},

		async concatAllFiles() {
			const { ih, torrentInfo } = store
			if (!ih || !torrentInfo.files.length) {
				return false
			}

			const MAX_SIZE = 100 * 1024 * 1024 // 100MB in bytes

			// Find groups of consecutive cached files
			const files = torrentInfo.files.slice()
			let currentGroup = []
			const groups = []

			for (const file of files) {
				if (file.cached) {
					currentGroup.push(file)
				} else {
					if (currentGroup.length > 1) {
						groups.push(currentGroup)
					}
					currentGroup = []
				}
			}
			// Add the last group if it exists
			if (currentGroup.length > 1) {
				groups.push(currentGroup)
			}

			// If no groups to concatenate, return
			if (groups.length === 0) {
				return false
			}

			// Process each group
			for (const originalGroup of groups) {
				// Split group into subgroups that don't exceed MAX_SIZE
				let currentSize = 0
				let subGroup = []
				const subGroups = []

				for (const file of originalGroup) {
					if (currentSize + file.length > MAX_SIZE && subGroup.length > 0) {
						// Current subgroup would exceed MAX_SIZE, start a new one
						if (subGroup.length > 1) {
							subGroups.push(subGroup)
						}
						subGroup = [file]
						currentSize = file.length
					} else {
						subGroup.push(file)
						currentSize += file.length
					}
				}
				// Add the last subgroup if it has more than one file
				if (subGroup.length > 1) {
					subGroups.push(subGroup)
				}

				// Process each subgroup
				for (const group of subGroups) {
					// Get files from storage
					const blobs = []
					for (const file of group) {
						const storedFile = await storage.getFile(ih, file.path.join('/'))
						if (!storedFile) {
							return false
						}
						blobs.push(storedFile.file)
					}


					// Concatenate files in the group
					const combinedBlob = await concatMP3Blobs(blobs)

					// Verify the combined size doesn't exceed MAX_SIZE
					if (combinedBlob.size > MAX_SIZE) {
						alert('Combined file would exceed 100MB limit')
						return false
					}

					// Save combined file to storage with range information
					const firstIndex = torrentInfo.files.findIndex(f => f.path.join('/') === group[0].path.join('/'))
					const rangePrefix = `${COMBINED_FILES_PREFIX}/${firstIndex}-${firstIndex + group.length - 1}/`
					const combinedPath = rangePrefix + group[0].path.join('/')
					await storage.addFile(ih, combinedPath, combinedBlob)

					// Remove original files from storage
					for (const file of group) {
						await storage.removeFile(ih, file.path.join('/'))
					}

					store.setTorrentInfo(ih)
				}
			}

			return true
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
	}, [ih, store])


	return store
}

function isMP3(buffer) {
	// Check for ID3v2 header
	if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) { // "ID3"
		return true
	}

	// Check for MPEG sync word (0xFF followed by 0xE0, 0xF0, or 0xF2)
	if (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0) {
		return true
	}

	return false
}

async function concatMP3Blobs(blobs) {
	if (!blobs || blobs.length === 0) {
		return new Blob([], { type: 'audio/mpeg' }); // Return an empty MP3 blob if no blobs are provided
	}

	const audioBuffers = [];
	for (const blob of blobs) {
		const arrayBuffer = await blob.arrayBuffer();
		const buffer = new Uint8Array(arrayBuffer);
		// skip non-mp3 files
		if (!isMP3(buffer)) {
			continue
		}
		audioBuffers.push(buffer);
	}

	// Calculate the total size of the combined audio data
	let totalLength = 0;
	for (const buffer of audioBuffers) {
		totalLength += buffer.length;
	}

	// Create a new Uint8Array to hold the combined data
	const combinedBuffer = new Uint8Array(totalLength);

	// Copy the data from each individual buffer into the combined buffer
	let offset = 0;
	for (const buffer of audioBuffers) {
		combinedBuffer.set(buffer, offset);
		offset += buffer.length;
	}

	// Verify the combined file is still a valid MP3
	if (!isMP3(combinedBuffer)) {
		throw new Error('Combined file is not a valid MP3');
	}

	// Create a new Blob from the combined buffer
	return new Blob([combinedBuffer], { type: 'audio/mpeg' });
}
