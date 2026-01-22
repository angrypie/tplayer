import React, { useRef, KeyboardEvent } from 'react'
import { useLocation } from 'wouter'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { ClipboardPaste } from 'lucide-react'

export const Search: React.FC = () => {
	const searchRef = useRef<HTMLInputElement>(null)
	const [, setLocation] = useLocation()

	const searchBook = (): void => {
		const query = searchRef.current?.value || ''
		const infoHash = extractInfoHash(query)
		if (infoHash) {
			setLocation(`/playlist/${infoHash}`)
		}
	}

	const handlePaste = async (): Promise<void> => {
		try {
			const text = await navigator.clipboard.readText()
			if (searchRef.current) {
				searchRef.current.value = text
			}
		} catch (err) {
			console.error('Failed to read clipboard:', err)
		}
	}

	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
		if (e.key === 'Enter') {
			searchBook()
		}
	}

	return (
		<div className='flex items-center gap-2 h-12 w-full'>
			<Input
				type='text'
				ref={searchRef}
				placeholder='magnet link or info hash'
				className='flex-1 min-w-0'
				onKeyDown={handleKeyDown}
			/>
			<Button className='h-10 whitespace-nowrap' variant='outline' onClick={handlePaste}>
				<ClipboardPaste className="h-4 w-4" />
			</Button>
			<Button className='h-10 whitespace-nowrap' onClick={searchBook}>
				search
			</Button>
		</div>
	)
}

function extractInfoHash(input: string): string | null {
	if (!input) return null
	input = input.trim()

	// Direct info hash (40 hex characters)
	if (/^[a-f0-9]{40}$/i.test(input)) {
		return input
	}

	// Magnet URI format
	try {
		const url = new URL(input)
		if (url.protocol !== 'magnet:') return null

		// Get xt parameter
		const xt = url.searchParams.get('xt')
		if (!xt) return null

		// Extract info hash from xt parameter
		const matches = xt.match(/^urn:btih:([a-f0-9]{40})$/i)
		return matches ? matches[1] : null
	} catch {
		return null
	}
}
