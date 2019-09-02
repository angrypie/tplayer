import { useLocalStore } from 'mobx-react-lite'
import { getTorrentInfo, getAudio } from './api'
import { usePlayerStore } from './Player/store'

export const useBookStores = ({ ih }) => {
	const playerStore = usePlayerStore()
	const bookStore = useBookStore({ ih, playerStore })
	return {
		bookStore,
		playerStore,
	}
}

export const useBookStore = ({ ih, playerStore }) => {
	const store = useLocalStore(() => ({
		playerStore: playerStore,
		ih,
		audio: null,
		torrentInfo: { name: '', files: [], length: 0 },
		currentFile: { path: [] },

		getNextFile() {
			const files = store.torrentInfo.files
			const currentPath = store.currentFile.path
			const currentIndex = files.findIndex(
				({ path }) => path.join('/') === currentPath.join('/')
			)
			return files[currentIndex + 1]
		},

		prepareNextFile() {

		},

		async setCurrentFile(file) {
			if(typeof file !== 'object') {
				return
			}
			if (file.cached === true) {
				store.currentFile = file
				setTimeout(() => store.playerStore.play(), 200)
				return true
			}
			file.state = 'loading'
			const url = await store.getAudio(file)
			if(url === null) {
				file.state = ''
				alert('File is not available')
			}
			return false
		},

		async setTorrentInfo(ih) {
			const info = await getTorrentInfo(ih)
			const { name = '', files = [], length = 0 } = info
			store.torrentInfo = { name: info['name.utf-8'] || name, files, length }
		},

		updateCached({ path }, cached) {
			const file = store.torrentInfo.files.find(
				({ path: p }) => path.join('/') === p.join('/')
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
			if(url !== null) {
				store.updateCached({ path }, true)
			}
			return url
		},
	}))

	store.playerStore.player.onEnd = async () => {
		const nextFile = store.getNextFile()
		const ok = await store.setCurrentFile(nextFile)
		if (!ok) {
			store.setCurrentFile(nextFile)
		}
	}

	return store
}
