import React, { useEffect } from 'react'
import { ThemeToggle } from '~/components/theme-toggle'
import { Search } from './Search'
import { AvailableBooks, Library } from './library'
import { useLibraryStore } from './libraryStore'

const Home = () => {
	const store = useLibraryStore()
	useEffect(() => {
		store.updateLibraryItems()
	}, [store])
	return (
		<div className='flex flex-col h-screen'>
			<div className='flex items-center gap-2 px-3 py-2'>
				<div className='flex-1 min-w-0'>
					<Search />
				</div>
				<ThemeToggle />
			</div>
			<div className='flex-1 overflow-auto mt-4'>
				<Library store={store} />
				<AvailableBooks />
			</div>
		</div>
	)
}

export default Home
