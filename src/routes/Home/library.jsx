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
	const [isLoading, setIsLoading] = React.useState(false)
	const [isVisible, setIsVisible] = React.useState(false)

	const fetchBooks = async () => {
		setIsLoading(true)
		try {
			const torrents = await getAvailableTorrents()
			const sortedTorrents = torrents.sort(
				(a, b) => new Date(b.lastSeen) - new Date(a.lastSeen)
			)
			setBooks(sortedTorrents)
			setIsVisible(true)
		} finally {
			setIsLoading(false)
		}
	}

	const handleDelete = async (infoHash, name) => {
		// biome-ignore lint/suspicious/noAlert: Keep the existing confirmation step without introducing a new dialog system.
		const confirmed = window.confirm(`Delete "${name}" from server?`)
		if (!confirmed) {
			return
		}
		const ok = await deleteAvailableTorrent(infoHash)
		if (ok) {
			setBooks((prevBooks) =>
				prevBooks.filter((book) => book.infoHash !== infoHash)
			)
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
		setIsVisible(false)
		setBooks([])
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
							books.map((book) => (
								<div
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
										</div>
									</Link>
									<Button
										className='mt-3 opacity-40 transition-opacity duration-200 hover:opacity-100'
										data-book-name={book.name}
										data-info-hash={book.infoHash}
										onClick={handleDeleteClick}
										size='sm'
										variant='link'
									>
										Delete
									</Button>
								</div>
							))
						)}
					</div>
				</>
			) : (
				<Button
					className='mt-2 p-2 underline underline-offset-4 opacity-30 transition-opacity duration-200 hover:opacity-100 disabled:cursor-not-allowed'
					disabled={isLoading}
					onClick={fetchBooks}
					size='sm'
					variant='link'
				>
					{isLoading ? 'Loading...' : 'Show books available on server'}
				</Button>
			)}
		</div>
	)
}
