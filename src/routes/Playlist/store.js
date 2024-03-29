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
