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

		setCurrentFile(file) {
			if (file.cached === true) {
				console.log('file cached')
				store.currentFile = file
				setTimeout(() => store.playerStore.play(), 200)
				return
			}
			file.state = 'loading'
			store.getAudio(file)
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
			try {
				const url = await getAudio(ih, path)
				store.updateCached({ path }, true)
				return url
			} catch (err) {
				return null
			}
		},
	}))

	return store
}
