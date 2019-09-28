import { useLocalStore } from 'mobx-react-lite'
import { storage } from '~/storage'

export const useLibraryStore = () => {
	const store = useLocalStore(() => ({
		items: [],

		async updateLibraryItems() {
			store.items = await storage.getTorrents()
		},
	}))

	return store
}
