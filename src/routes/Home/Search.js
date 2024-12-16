import React, { useRef } from 'react'
import { useLocation } from 'wouter'
import { Button } from '~/components/ui/button'

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
			<Button variant="outline" onClick={handlePaste}>
				paste
			</Button>
			<Button onClick={() => searchBook()}>
				search
			</Button>
		</div>
	)
}
