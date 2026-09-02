import { AudioLines, Settings as SettingsIcon } from 'lucide-react'
import { useEffect } from 'react'
import { Link } from 'wouter'
import { ContentUseDialog } from '~/components/ContentUseDialog'
import { Nav } from '~/components/layout/Nav'
import { PageContent, PageShell } from '~/components/layout/Page'
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
		<PageShell>
			<ContentUseDialog
				action={contentUseConfirmation?.action ?? 'open-direct'}
				isOpen={contentUseConfirmation !== null}
				onCancel={searchController.cancelContentUseConfirmation}
				onConfirm={searchController.confirmContentUseConfirmation}
				sourceLabel={contentUseConfirmation?.sourceLabel}
			/>
			<Nav className='flex-wrap gap-3'>
				<div className='mr-auto flex items-center gap-2.5'>
					<div className='grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm'>
						<AudioLines aria-hidden='true' className='size-5' />
					</div>
					<div>
						<h1 className='font-semibold leading-none tracking-tight'>
							TPlayer
						</h1>
						<p className='mt-1 text-muted-foreground text-xs'>
							Your audiobook library
						</p>
					</div>
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
				<div className='order-last w-full'>
					<Search controller={searchController} />
				</div>
			</Nav>
			<PageContent className='space-y-8'>
				{searchController.hasSearched ? (
					<SearchResults controller={searchController} />
				) : (
					<>
						<Library store={store} />
						<AvailableBooks />
					</>
				)}
			</PageContent>
		</PageShell>
	)
}

export default Home
