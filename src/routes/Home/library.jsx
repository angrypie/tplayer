import { observer } from 'mobx-react-lite'
import React from 'react'
import { Link } from 'wouter'
import { CoverImage } from '~/components/CoverImage'
import { Button } from '~/components/ui/button'
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
				<progress
					aria-label={`Download progress for ${book.name}`}
					className='h-1.5 w-full accent-primary'
					max={100}
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
			<Link key={i} to={`/playlist/${ih}`}>
				<div className='my-3 flex cursor-pointer items-center gap-3'>
					<CoverImage
						className='h-16 w-16'
						files={info.files || []}
						ih={ih}
						loadingLabel='Loading...'
						name={name}
						placeholderClassName='text-[10px] text-[var(--text-secondary)]'
					/>
					<div className='flex flex-1 items-center justify-between gap-3'>
						<div className='w-4/5 truncate'>{name}</div>
						<BookState state={state} />
					</div>
				</div>
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
		<div className='mx-3 flex flex-col'>
			{recent.length > 0 && (
				<>
					<div className='font-bold text-2xl'>Recent</div>
					{recent}
				</>
			)}
			<div className='font-bold text-2xl'>Library</div>
			{library.length > 0 ? (
				library
			) : (
				<div className='my-3 text-gray-500'>
					{recent.length > 0
						? 'No more books in library'
						: 'No books in library'}
				</div>
			)}
		</div>
	)
})

const BookState = ({ state }) => {
	if (!state || state.time < 10) {
		return null
	}
	return <div className='text-red-500'>*</div>
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
		<div className='p-4'>
			{isVisible ? (
				<>
					<div className='flex items-center justify-between'>
						<h2 className='font-bold text-xl'>Available Books</h2>
						<Button
							className='underline underline-offset-4 opacity-30 transition-opacity duration-200 hover:opacity-100'
							onClick={hideBooks}
							size='sm'
							variant='link'
						>
							Hide books
						</Button>
					</div>
					<div className='mt-4 grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4'>
						{books.length === 0 ? (
							<div className='my-3 text-gray-500'>
								No books available on server
							</div>
						) : (
							books.map((book) => {
								const deleting = deletingInfoHashes.has(book.infoHash)
								const deleteError = deleteErrors[book.infoHash]
								return (
									<div
										aria-busy={deleting}
										className='rounded-lg bg-[var(--bg-elevated)] p-4'
										key={book.infoHash}
									>
										<Link href={`/playlist/${book.infoHash}`}>
											<div className='cursor-pointer transition-transform duration-200 hover:-translate-y-0.5'>
												<div className='mb-2 break-words font-medium'>
													{book.name}
												</div>
												<div className='flex justify-between text-[var(--text-secondary)] text-sm'>
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
											className='mt-3 opacity-40 transition-opacity duration-200 hover:opacity-100'
											data-book-name={book.name}
											data-info-hash={book.infoHash}
											disabled={deleting}
											onClick={handleDeleteClick}
											size='sm'
											type='button'
											variant='link'
										>
											{deleteButtonLabel(deleting, deleteError)}
										</Button>
									</div>
								)
							})
						)}
					</div>
				</>
			) : (
				<Button
					className='mt-2 p-2 underline underline-offset-4 opacity-30 transition-opacity duration-200 hover:opacity-100 disabled:cursor-not-allowed'
					disabled={isLoading}
					onClick={showBooks}
					size='sm'
					variant='link'
				>
					{isLoading ? 'Loading...' : 'Show books available on server'}
				</Button>
			)}
		</div>
	)
}
