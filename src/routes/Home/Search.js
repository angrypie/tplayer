import React, { useRef } from 'react'
import { useLocation } from 'wouter'
import { Button } from '~/components/ui/button'
import { ClipboardPaste } from 'lucide-react'

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

	// <div onClick={handlePaste} className='f6 link dim ba ph3 pv2 dib black pointer'>
	// 	<span className='black'>paste</span>
	// </div>
	return (
		<div className='flex items-center gap-0.5 mx-3 h-12'>
			<input 
				type='text' 
				ref={searchRef} 
				className='flex-1 px-3 py-2 rounded-md border h-10 min-w-0' 
				placeholder='magnet link or info hash' 
			/>
			<Button className='h-10 whitespace-nowrap' variant='outline' onClick={() => handlePaste()}><ClipboardPaste className="h-4 w-4" /></Button>
			<Button className='h-10 whitespace-nowrap' onClick={() => searchBook()}>search</Button>
		</div>
	)
}
