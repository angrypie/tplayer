import { Settings as SettingsIcon } from 'lucide-react'
import { useEffect } from 'react'
import { Link } from 'wouter'
import { ContentUseDialog } from '~/components/ContentUseDialog'
import { Nav } from '~/components/layout/Nav'
import { ThemeToggle } from '~/components/theme-toggle'
import { Button } from '~/components/ui/button'
import { AvailableBooks, Library } from './library'
import { useLibraryStore } from './libraryStore'
import { Search } from './Search'
import { SearchResults } from './SearchResults'
import { useAudiobookSearch } from './useAudiobookSearch'

const Home = () => {
	const store = useLibraryStore()
	const searchController = useAudiobookSearch()
	const { contentUseConfirmation } = searchController
	useEffect(() => {
		store.updateLibraryItems()
	}, [store])
	return (
		<div className='flex h-screen flex-col'>
			<ContentUseDialog
				action={contentUseConfirmation?.action ?? 'open-direct'}
				isOpen={contentUseConfirmation !== null}
				onCancel={searchController.cancelContentUseConfirmation}
				onConfirm={searchController.confirmContentUseConfirmation}
				sourceLabel={contentUseConfirmation?.sourceLabel}
			/>
			<Nav>
				<div className='min-w-0 flex-1'>
					<Search controller={searchController} />
				</div>
				<Button
					aria-label='Search settings'
					asChild
					size='icon'
					variant='outline'
				>
					<Link href='/settings'>
						<SettingsIcon className='h-4 w-4' />
					</Link>
				</Button>
				<ThemeToggle />
			</Nav>
			<div className='mt-4 flex-1 overflow-auto'>
				{searchController.hasSearched ? (
					<SearchResults controller={searchController} />
				) : (
					<>
						<Library store={store} />
						<AvailableBooks />
					</>
				)}
			</div>
		</div>
	)
}

export default Home
