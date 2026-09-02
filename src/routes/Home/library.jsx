import { BookOpen, CloudDownload } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import React from 'react'
import { Link } from 'wouter'
import { CoverImage } from '~/components/CoverImage'
import { SectionHeading } from '~/components/layout/Page'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card } from '~/components/ui/card'
import { EmptyState } from '~/components/ui/empty-state'
import { Progress } from '~/components/ui/progress'
import {
	deleteAvailableTorrent,
	getAvailableTorrents,
} from '~/routes/Playlist/api'

const recentBooksNumber = 2
const availableBooksPollIntervalMs = 3000

const deleteErrorMessage = (error) =>
	error instanceof Error
		? error.message
		: 'The server could not delete this torrent. Please try again.'

const deleteButtonLabel = (deleting, error) => {
	if (deleting) {
		return 'Deleting…'
	}
	return error ? 'Retry delete' : 'Delete'
}

const availableBookProgress = (book) => {
	if ((book.totalBytes ?? 0) > 0) {
		return Math.min(
			100,
			Math.max(0, ((book.downloadedBytes ?? 0) / book.totalBytes) * 100)
		)
	}
	return Math.min(100, Math.max(0, (book.progress ?? 0) * 100))
}

const availableBookStatus = (book) => {
	if (book.state === 'fetching_metadata') {
		return 'Fetching metadata'
	}
	if (book.state === 'downloading') {
		return `Downloading ${Math.floor(availableBookProgress(book))}%`
	}
	if (book.state === 'completed') {
		return 'Ready'
	}
	if (book.state === 'failed') {
		return 'Failed'
	}
	if (book.state === 'idle') {
		return 'Idle'
	}
	return 'Stored on server'
}

const AvailableBookStatus = ({ book, deleting }) => {
	if (deleting) {
		return (
			<div className='mt-2 text-muted-foreground text-sm' role='status'>
				Stopping download and deleting cached files…
			</div>
		)
	}
	const progress = availableBookProgress(book)
	return (
		<div className='mt-2 space-y-1' role='status'>
			<div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-sm'>
				<span className='font-medium text-foreground'>
					{availableBookStatus(book)}
				</span>
				{(book.numPeers ?? 0) > 0 ? (
					<span>
						{book.numPeers} {book.numPeers === 1 ? 'peer' : 'peers'}
					</span>
				) : null}
			</div>
			{book.state === 'downloading' && (book.totalBytes ?? 0) > 0 ? (
				<Progress
					aria-label={`Download progress for ${book.name}`}
					value={progress}
				/>
			) : null}
		</div>
	)
}

export const Library = observer(({ store }) => {
	const renderBook = ({ info, ih, state }, i) => {
		const name = info['name.utf-8'] || info.name
		return (
			<Link className='block' key={i} to={`/playlist/${ih}`}>
				<Card className='group flex items-center gap-3 p-3 transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md'>
					<CoverImage
						className='h-16 w-16'
						files={info.files || []}
						ih={ih}
						loadingLabel='Loading...'
						name={name}
						placeholderClassName='text-[10px] text-muted-foreground'
					/>
					<div className='flex min-w-0 flex-1 items-center justify-between gap-3'>
						<div className='truncate font-medium'>{name}</div>
						<BookState state={state} />
					</div>
				</Card>
			</Link>
		)
	}

	const updatedAt = (book) => (book.state ? book.state.updatedAt : 0)
	const compareUpdatedAt = (a, b) => updatedAt(b) - updatedAt(a)

	const books = store.items.slice()

	const [rest, history] = partition(
		books,
		({ state }) => state !== undefined && state.updatedAt !== undefined
	)
	const sorted = history.sort(compareUpdatedAt)

	const recent = sorted.slice(0, recentBooksNumber).map(renderBook)
	const library = sorted.slice(recentBooksNumber).concat(rest).map(renderBook)

	return (
		<div className='space-y-8'>
			{recent.length > 0 && (
				<section className='space-y-3'>
					<SectionHeading title='Recent' />
					<div className='space-y-2'>{recent}</div>
				</section>
			)}
			<section className='space-y-3'>
				<SectionHeading
					description='Books saved in this browser appear here.'
					title='Library'
				/>
				{library.length > 0 ? (
					<div className='space-y-2'>{library}</div>
				) : (
					<EmptyState
						description={
							recent.length > 0
								? 'Your other saved books will appear here.'
								: 'Search for an audiobook or open an authorized magnet link to get started.'
						}
						icon={BookOpen}
						title={
							recent.length > 0
								? 'No more books in library'
								: 'No books in library'
						}
					/>
				)}
			</section>
		</div>
	)
})

const BookState = ({ state }) => {
	if (!state || state.time < 10) {
		return null
	}
	return <Badge variant='outline'>In progress</Badge>
}

const partition = (arr, f) =>
	arr.reduce((a, x) => a[f(x) + 0].push(x) && a, [[], []])

export const AvailableBooks = () => {
	const [books, setBooks] = React.useState([])
	const [deleteErrors, setDeleteErrors] = React.useState({})
	const [deletingInfoHashes, setDeletingInfoHashes] = React.useState(
		() => new Set()
	)
	const [isLoading, setIsLoading] = React.useState(false)
	const [isVisible, setIsVisible] = React.useState(false)
	const deleteRequestsRef = React.useRef(new Set())
	const requestIdRef = React.useRef(0)

	React.useEffect(
		() => () => {
			requestIdRef.current += 1
		},
		[]
	)

	const fetchBooks = React.useCallback(async (showLoading = false) => {
		const requestId = requestIdRef.current + 1
		requestIdRef.current = requestId
		if (showLoading) {
			setIsLoading(true)
		}
		try {
			const torrents = await getAvailableTorrents()
			if (requestId !== requestIdRef.current) {
				return
			}
			const sortedTorrents = torrents.sort(
				(a, b) => new Date(b.lastSeen) - new Date(a.lastSeen)
			)
			setBooks(sortedTorrents)
		} finally {
			if (showLoading && requestId === requestIdRef.current) {
				setIsLoading(false)
			}
		}
	}, [])

	React.useEffect(() => {
		if (!isVisible) {
			return
		}
		const interval = setInterval(() => {
			fetchBooks().catch(() => undefined)
		}, availableBooksPollIntervalMs)
		return () => clearInterval(interval)
	}, [fetchBooks, isVisible])

	const handleDelete = async (infoHash, name) => {
		if (deleteRequestsRef.current.has(infoHash)) {
			return
		}
		// biome-ignore lint/suspicious/noAlert: Keep the existing confirmation step without introducing a new dialog system.
		const confirmed = window.confirm(`Delete "${name}" from server?`)
		if (!confirmed) {
			return
		}
		deleteRequestsRef.current.add(infoHash)
		setDeletingInfoHashes((current) => new Set(current).add(infoHash))
		setDeleteErrors((current) => {
			const next = { ...current }
			delete next[infoHash]
			return next
		})
		try {
			await deleteAvailableTorrent(infoHash)
			requestIdRef.current += 1
			setBooks((prevBooks) =>
				prevBooks.filter((book) => book.infoHash !== infoHash)
			)
		} catch (error) {
			setDeleteErrors((current) => ({
				...current,
				[infoHash]: deleteErrorMessage(error),
			}))
		} finally {
			deleteRequestsRef.current.delete(infoHash)
			setDeletingInfoHashes((current) => {
				const next = new Set(current)
				next.delete(infoHash)
				return next
			})
		}
	}

	const handleDeleteClick = async (event) => {
		const { bookName, infoHash } = event.currentTarget.dataset
		if (bookName === undefined || infoHash === undefined) {
			return
		}
		await handleDelete(infoHash, bookName)
	}

	const hideBooks = () => {
		requestIdRef.current += 1
		setIsVisible(false)
		setBooks([])
		setDeleteErrors({})
	}

	const showBooks = async () => {
		await fetchBooks(true)
		setIsVisible(true)
	}

	return (
		<section className='space-y-3'>
			{isVisible ? (
				<>
					<SectionHeading
						action={
							<Button onClick={hideBooks} size='sm' variant='outline'>
								Hide books
							</Button>
						}
						description='Background downloads and cached books from the TPlayer server.'
						title='Available Books'
					/>
					<div className='grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3'>
						{books.length === 0 ? (
							<EmptyState
								className='col-span-full'
								icon={CloudDownload}
								title='No books available on server'
							/>
						) : (
							books.map((book) => {
								const deleting = deletingInfoHashes.has(book.infoHash)
								const deleteError = deleteErrors[book.infoHash]
								return (
									<Card
										aria-busy={deleting}
										className='p-4'
										key={book.infoHash}
									>
										<Link href={`/playlist/${book.infoHash}`}>
											<div className='cursor-pointer'>
												<div className='mb-2 break-words font-medium'>
													{book.name}
												</div>
												<div className='flex justify-between text-muted-foreground text-sm'>
													<span>
														Last requested: {book.lastSeen.toLocaleDateString()}
													</span>
												</div>
												<AvailableBookStatus book={book} deleting={deleting} />
											</div>
										</Link>
										{deleteError ? (
											<p className='mt-2 text-destructive text-sm' role='alert'>
												Delete failed: {deleteError}
											</p>
										) : null}
										<Button
											className='mt-3 px-0 text-destructive hover:text-destructive'
											data-book-name={book.name}
											data-info-hash={book.infoHash}
											disabled={deleting}
											onClick={handleDeleteClick}
											size='sm'
											type='button'
											variant='ghost'
										>
											{deleteButtonLabel(deleting, deleteError)}
										</Button>
									</Card>
								)
							})
						)}
					</div>
				</>
			) : (
				<Card className='flex flex-col items-stretch gap-4 p-4 sm:flex-row sm:items-center sm:justify-between'>
					<div>
						<h2 className='font-medium'>Server library</h2>
						<p className='text-muted-foreground text-sm'>
							See books currently cached or downloading on the server.
						</p>
					</div>
					<Button
						className='w-full sm:w-auto'
						disabled={isLoading}
						onClick={showBooks}
						size='sm'
						variant='outline'
					>
						{isLoading ? 'Loading...' : 'Show books available on server'}
					</Button>
				</Card>
			)}
		</section>
	)
}
