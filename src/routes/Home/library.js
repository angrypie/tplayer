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

	const recent = store.items.slice(0, 2).map(renderBook)
	const library = store.items.map(renderBook)

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
