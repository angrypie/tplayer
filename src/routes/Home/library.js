import React from 'react'
import { observer } from 'mobx-react-lite'
import { Link } from 'wouter'
import { getAvailableTorrents } from '~/routes/Playlist/api'
export const Library = observer(({ store }) => {
	const renderBook = ({ info, ih, state }, i) => {
		const name = info['name.utf-8'] || info['name']
		return (
			<Link key={i} to={`/playlist/${ih}`}>
				<div className='flex justify-between mv3 pointer'>
					<div className='truncate w-80'>{name}</div>
					<BookState state={state} />
				</div>
			</Link>
		)
	}

	const updatedAt = book => !book.state ? 0 : book.state.updatedAt
	const compareUpdatedAt = (a, b) => updatedAt(b) - updatedAt(a)

	const books = store.items.slice()

	const [rest, history] = partition(books, ({ state }) => state !== undefined && state.updatedAt !== undefined)
	const sorted = history.sort(compareUpdatedAt)

	const recent = sorted.slice(0, 3).map(renderBook)
	const library = sorted.slice(1).concat(rest).map(renderBook)

	return (
		<div className='flex flex-column mh3'>
			{recent.length > 0 && (
				<>
					<div className='f3 b'>Recent</div>
					{recent}
				</>
			)}
			<div className='f3 b'>Library</div>
			{library.length > 0 ? library : <div className='mv3 gray'>{recent.length > 0 ? 'No more books in library' : 'No books in library'}</div>}
		</div>
	)
})

const BookState = ({ state }) => {
	if (!state || state.time < 10) {
		return null
	}
	return <div className='red'>*</div>
}

//[rest, passed]
const partition = (arr, f) => arr.reduce((a, x) => a[f(x) + 0].push(x) && a, [[], []])

export const AvailableBooks = () => {
	const [books, setBooks] = React.useState([])
	const [isLoading, setIsLoading] = React.useState(false)
	const [isVisible, setIsVisible] = React.useState(false)

	const fetchBooks = async () => {
		setIsLoading(true)
		try {
			const torrents = await getAvailableTorrents()
			// Sort by lastUsed in descending order
			const sortedTorrents = torrents.sort((a, b) =>
				new Date(b.lastUsed) - new Date(a.lastUsed)
			)
			setBooks(sortedTorrents)
			setIsVisible(true)
		} finally {
			setIsLoading(false)
		}
	}


	return (
		<div className="available-books">
			{!isVisible ? (
				<button
					className="load-button dim f6 underline"
					onClick={fetchBooks}
					disabled={isLoading}
				>
					{isLoading ? 'Loading...' : 'Show books available on server'}
				</button>
			) : (
					<>
						<h2>Available Books</h2>
						<div className="books-grid">
							{
								books.length === 0 ? (
									<div className='mv3 gray'>No books available on server</div>
								) : (
										books.map(book => (
											<Link
												key={book.infoHash}
												href={`/playlist/${book.infoHash}`}
											>
												<div className="book-item">
													<div className="book-title">{book.name}</div>
													<div className="book-meta">
														<span>Last played: {book.lastUsed.toLocaleDateString()}</span>
													</div>
												</div>
											</Link>
										))
									)
							}

						</div>
					</>
				)}
			<style jsx>{`
                .available-books {
                    padding: 1rem;
                }
                .load-button {
                    background: var(--bg-elevated);
                    border: none;
										margin-top: 8px;
                    border-radius: 8px;
                    color: inherit;
                    cursor: pointer;
										opacity: 0.3;
										padding: 0.5rem;
                    transition: transform 0.2s;
                }
								.load-button:hover {
									opacity: 1;
								}
                .load-button:disabled {
                    cursor: not-allowed;
                }
                .books-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
                    gap: 1rem;
                    margin-top: 1rem;
                }
                .book-item {
                    background: var(--bg-elevated);
                    padding: 1rem;
                    border-radius: 8px;
                    cursor: pointer;
                    transition: transform 0.2s;
                    text-decoration: none;
                    color: inherit;
                }
                .book-item:hover {
                    transform: translateY(-2px);
                }
                .book-title {
                    font-weight: 500;
                    margin-bottom: 0.5rem;
                }
                .book-meta {
                    font-size: 0.9rem;
                    color: var(--text-secondary);
                    display: flex;
                    justify-content: space-between;
                }
            `}</style>
		</div>
	)
}
