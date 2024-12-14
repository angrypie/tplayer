import React, { useEffect } from 'react'
import { Search } from './Search'
import { AvailableBooks, Library } from './library'
import { useLibraryStore } from './libraryStore'

const Home = () => {
	const store = useLibraryStore()
	useEffect(() => {
		store.updateLibraryItems()
	}, [store])
	return (
		<div className='container'>
			<Search />
			<div className='flex flex-column'>
				<Library store={store} />
				<AvailableBooks />
			</div>
		</div>
	)
}

export default Home
