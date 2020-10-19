import { useLocalObservable } from 'mobx-react-lite'
import { storage } from '~/storage'

export const useLibraryStore = () => {
	const store = useLocalObservable(() => ({
		items: [],

		async updateLibraryItems() {
			store.items = await storage.getTorrents()
		},
	}))

	return store
}
