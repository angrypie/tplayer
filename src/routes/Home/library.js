import React from 'react'
import { observer } from 'mobx-react-lite'
import { Link } from 'wouter'

export const Library = observer(({ store }) => {
	const books = store.items.map(({ info, ih, state }, i) => {
		const name = info['name.utf-8'] || info['name']
		return (
			<Link key={i} to={`/playlist/${ih}`}>
				<div className='flex justify-between mv3 pointer'>
					<div className='truncate w-80'>{name}</div>
					<BookState state={state} />
				</div>
			</Link>
		)
	})

	return <div className='flex flex-column mh3'>{books}</div>
})

const BookState = ({ state }) => {
	if (!state || state.time < 10) {
		return null
	}
	return <div className='red'>*</div>
}
