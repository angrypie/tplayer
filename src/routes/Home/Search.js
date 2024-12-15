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

	const handlePaste = async () => {
		try {
			const text = await navigator.clipboard.readText()
			if (searchRef.current) {
				searchRef.current.value = text
			}
		} catch (err) {
			console.error('Failed to read clipboard:', err)
		}
	}

	return (
		<div className='flex gap mh3'>
			<input type='text' ref={searchRef} className='flex-auto' placeholder='paste magnet link or info hash' />
			<div onClick={handlePaste} className='f6 link dim ba ph3 pv2 dib black pointer'>
				<span className='black'>paste</span>
			</div>
			<div onClick={() => searchBook()} className='f6 pointer dim ph3 pv2 dib white bg-black'>
				<span className='b white'>search</span>
			</div>
		</div>
	)
}
