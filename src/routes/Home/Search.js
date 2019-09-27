import React, { useRef } from 'react'
import { useLocation } from 'wouter'

export const Search = () => {
	const searchRef = useRef(null)
	const [, setLocation] = useLocation()

	const searchBook = () => {
		const query = searchRef.current.value
		const matches = query.match(/([A-F\d]{40})/i)
		if (matches === null) {
			return
		}

		const ih = matches[1]
		setLocation(`/playlist/${ih}`)
	}

	return (
		<div className='flex'>
			<input type='text' ref={searchRef} />
			<button onClick={() => searchBook()}>Search</button>
		</div>
	)
}
