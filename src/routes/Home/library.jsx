import React from 'react'
import { observer } from 'mobx-react-lite'
import { Link } from 'wouter'
import { Button } from '~/components/ui/button'
import { deleteAvailableTorrent, getAvailableTorrents } from '~/routes/Playlist/api'
import { CoverImage } from '~/components/CoverImage'

const recentBooksNumber = 2

export const Library = observer(({ store }) => {
	const renderBook = ({ info, ih, state }, i) => {
		const name = info['name.utf-8'] || info.name
		return (
			<Link key={i} to={`/playlist/${ih}`}>
				<div className='flex gap-3 items-center my-3 cursor-pointer'>
					<CoverImage
						ih={ih}
						files={info.files || []}
						name={name}
						className='w-16 h-16'
						placeholderClassName='text-[10px] text-[var(--text-secondary)]'
						loadingLabel='Loading...'
					/>
					<div className='flex-1 flex items-center justify-between gap-3'>
						<div className='truncate w-4/5'>{name}</div>
						<BookState state={state} />
					</div>
				</div>
			</Link>
		)
	}

	const updatedAt = book => !book.state ? 0 : book.state.updatedAt
	const compareUpdatedAt = (a, b) => updatedAt(b) - updatedAt(a)

	const books = store.items.slice()

	const [rest, history] = partition(books, ({ state }) => state !== undefined && state.updatedAt !== undefined)
	const sorted = history.sort(compareUpdatedAt)

	const recent = sorted.slice(0, recentBooksNumber).map(renderBook)
	const library = sorted.slice(recentBooksNumber).concat(rest).map(renderBook)

	return (
		<div className='flex flex-col mx-3'>
			{recent.length > 0 && (
				<>
					<div className='text-2xl font-bold'>Recent</div>
					{recent}
				</>
			)}
			<div className='text-2xl font-bold'>Library</div>
			{library.length > 0 ? library : <div className='my-3 text-gray-500'>{recent.length > 0 ? 'No more books in library' : 'No books in library'}</div>}
		</div>
	)
})

const BookState = ({ state }) => {
	if (!state || state.time < 10) {
		return null
	}
	return <div className='text-red-500'>*</div>
}

const partition = (arr, f) => arr.reduce((a, x) => a[f(x) + 0].push(x) && a, [[], []])

export const AvailableBooks = () => {
	const [books, setBooks] = React.useState([])
	const [isLoading, setIsLoading] = React.useState(false)
	const [isVisible, setIsVisible] = React.useState(false)

	const fetchBooks = async () => {
		setIsLoading(true)
		try {
			const torrents = await getAvailableTorrents()
			const sortedTorrents = torrents.sort((a, b) =>
				new Date(b.lastSeen) - new Date(a.lastSeen)
			)
			setBooks(sortedTorrents)
			setIsVisible(true)
		} finally {
			setIsLoading(false)
		}
	}

	const handleDelete = async (infoHash, name) => {
		const confirmed = window.confirm(`Delete "${name}" from server?`)
		if (!confirmed) {
			return
		}
		const ok = await deleteAvailableTorrent(infoHash)
		if (ok) {
			setBooks(prevBooks => prevBooks.filter(book => book.infoHash !== infoHash))
		}
	}

	const hideBooks = () => {
		setIsVisible(false)
		setBooks([])
	}

	return (
		<div className="p-4">
			{!isVisible ? (
				<Button
					variant="link"
					size="sm"
					className="mt-2 p-2 opacity-30 hover:opacity-100 transition-opacity duration-200 disabled:cursor-not-allowed underline underline-offset-4"
					onClick={fetchBooks}
					disabled={isLoading}
				>
					{isLoading ? 'Loading...' : 'Show books available on server'}
				</Button>
			) : (
				<>
					<div className="flex justify-between items-center">
						<h2 className="text-xl font-bold">Available Books</h2>
						<Button
							variant="link"
							size="sm"
							className="opacity-30 hover:opacity-100 transition-opacity duration-200 underline underline-offset-4"
							onClick={hideBooks}
						>
							Hide books
						</Button>
					</div>
					<div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4 mt-4">
						{books.length === 0 ? (
							<div className='my-3 text-gray-500'>No books available on server</div>
						) : (
						books.map(book => (
							<div key={book.infoHash} className="p-4 rounded-lg bg-[var(--bg-elevated)]">
								<Link href={`/playlist/${book.infoHash}`}>
									<div className="cursor-pointer hover:-translate-y-0.5 transition-transform duration-200">
										<div className="font-medium mb-2 break-words">{book.name}</div>
										<div className="text-sm text-[var(--text-secondary)] flex justify-between">
											<span>Last requested: {book.lastSeen.toLocaleDateString()}</span>
										</div>
									</div>
								</Link>
								<Button
									variant="link"
									size="sm"
									className="mt-3 opacity-40 hover:opacity-100 transition-opacity duration-200"
									onClick={() => handleDelete(book.infoHash, book.name)}
								>
									Delete
								</Button>
							</div>
						))

						)}
					</div>
				</>
			)}
		</div>
	)
}
