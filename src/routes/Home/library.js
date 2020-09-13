import React from 'react'
import { observer } from 'mobx-react-lite'
import { Link } from 'wouter'

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

	const books =  store.items.slice()

	const [rest, history] = partition(books, ({ state }) => state !== undefined && state.updatedAt !== undefined)
	const sorted = history.sort(compareUpdatedAt)

	const recent = sorted.slice(0,1).map(renderBook)
	const library = sorted.slice(1).concat(rest).map(renderBook)

	return (
		<div className='flex flex-column mh3'>
			<div className='f3 b'>Recent</div>
			{recent}
			<div className='f3 b'>Library</div>
			{library}
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
const partition = (arr, f) => arr.reduce((a, x) => a[f(x)+0].push(x) && a, [[],[]])
