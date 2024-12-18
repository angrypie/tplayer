import { useLocalObservable } from 'mobx-react-lite'
import { getTorrentInfo, getAudio } from './api'
import { usePlayerStore } from './Player/store'
import { storage } from '~/storage'
import { toJS } from 'mobx'
import { comparePath } from '~/utils'
import natsort from 'natsort'
import React from 'react'

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

		getNextFile() {
			const files = store.torrentInfo.files
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

		async deleteFile(file) {
			const { ih } = store
			if (!ih || !file?.path) {
				return false
			}

			try {
				// Get file path as string
				const path = file.path.join('/')

				// Check if file exists before trying to delete
				const existingFile = await storage.getFile(ih, path)
				if (!existingFile) {
					return false
				}

				// Try to remove the file
				const removed = await storage.removeFile(ih, path)
				if (!removed) {
					return false
				}
				
				// Update file status in torrent info only if deletion was successful
				const fileInList = store.torrentInfo.files.find(f => 
					comparePath(f.path, file.path)
				)
				if (fileInList) {
					fileInList.cached = false
					fileInList.state = ''
				}

				return true
			} catch (err) {
				console.error('Error deleting file:', err)
				return false
			}
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
							alert('Some files are missing')
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
					
					// Save combined file to storage
					const combinedPath = '_combined/' + group[0].path.join('/')
					await storage.addFile(ih, combinedPath, combinedBlob)

					// Remove original files from storage
					for (const file of group) {
						await storage.removeFile(ih, file.path.join('/'))
					}

					// Create combined file info
					const combinedFile = {
						path: combinedPath.split('/'),
						length: combinedBlob.size,
						cached: true,
						state: 'ready'
					}

					// Replace the group in torrentInfo.files with the combined file
					const firstIndex = torrentInfo.files.findIndex(f => f.path.join('/') === group[0].path.join('/'))
					torrentInfo.files.splice(firstIndex, group.length, combinedFile)
				}
			}

			return true
		},
	}))

	store.playerStore.player.onEnd = async () => {
		const nextFile = store.getNextFile()
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
		return new Blob([], { type: 'audio/mp3' }); // Return an empty MP3 blob if no blobs are provided
	}

	const audioBuffers = [];
	for (const blob of blobs) {
		const arrayBuffer = await blob.arrayBuffer();
		const buffer = new Uint8Array(arrayBuffer);
		
		// Check if the file is a valid MP3
		if (!isMP3(buffer)) {
			throw new Error('Invalid MP3 file detected');
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
	return new Blob([combinedBuffer], { type: 'audio/mp3' });
}
