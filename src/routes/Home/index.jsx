import { useEffect } from 'react'
import { Nav } from '~/components/layout/Nav'
import { ThemeToggle } from '~/components/theme-toggle'
import { AvailableBooks, Library } from './library'
import { useLibraryStore } from './libraryStore'
import { Search } from './Search'

const Home = () => {
	const store = useLibraryStore()
	useEffect(() => {
		store.updateLibraryItems()
	}, [store])
	return (
		<div className='flex h-screen flex-col'>
			<Nav>
				<div className='min-w-0 flex-1'>
					<Search />
				</div>
				<ThemeToggle />
			</Nav>
			<div className='mt-4 flex-1 overflow-auto'>
				<Library store={store} />
				<AvailableBooks />
			</div>
		</div>
	)
}

export default Home
