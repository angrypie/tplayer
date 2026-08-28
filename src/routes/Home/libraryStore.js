import { runInAction } from 'mobx'
import { useLocalObservable } from 'mobx-react-lite'
import { storage } from '~/storage'

export const useLibraryStore = () => {
	const store = useLocalObservable(() => ({
		items: [],

		async updateLibraryItems() {
			const items = await storage.getTorrents()
			runInAction(() => {
				store.items = items
			})
		},
	}))

	return store
}
