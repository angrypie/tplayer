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
		<div className='pv2'>
			<Search />
			<div className='flex flex-column mt4'>
				<Library store={store} />
				<AvailableBooks />
			</div>
		</div>
	)
}

export default Home
