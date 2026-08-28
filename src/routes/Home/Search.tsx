import { ClipboardPaste } from 'lucide-react'
import type React from 'react'
import { type ChangeEvent, type KeyboardEvent, useState } from 'react'
import { useLocation } from 'wouter'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'

const INFO_HASH_PATTERN = /^[a-f0-9]{40}$/i
const MAGNET_INFO_HASH_PATTERN = /^urn:btih:([a-f0-9]{40})$/i

export const Search: React.FC = () => {
	const [query, setQuery] = useState('')
	const [, setLocation] = useLocation()

	const searchBook = (): void => {
		const infoHash = extractInfoHash(query)
		if (infoHash) {
			setLocation(`/playlist/${infoHash}`)
		}
	}

	const handlePaste = async (): Promise<void> => {
		try {
			const text = await navigator.clipboard.readText()
			setQuery(text)
		} catch (err) {
			console.error('Failed to read clipboard:', err)
		}
	}

	const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
		setQuery(event.currentTarget.value)
	}

	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
		if (e.key === 'Enter') {
			searchBook()
		}
	}

	return (
		<div className='flex h-12 w-full items-center gap-2'>
			<Input
				className='min-w-0 flex-1'
				onChange={handleChange}
				onKeyDown={handleKeyDown}
				placeholder='magnet link or info hash'
				type='text'
				value={query}
			/>
			<Button
				className='h-10 whitespace-nowrap'
				onClick={handlePaste}
				variant='outline'
			>
				<ClipboardPaste className='h-4 w-4' />
			</Button>
			<Button className='h-10 whitespace-nowrap' onClick={searchBook}>
				search
			</Button>
		</div>
	)
}

function extractInfoHash(input: string): string | null {
	if (!input) {
		return null
	}
	const normalizedInput = input.trim()

	// Direct info hash (40 hex characters)
	if (INFO_HASH_PATTERN.test(normalizedInput)) {
		return normalizedInput
	}

	// Magnet URI format
	try {
		const url = new URL(normalizedInput)
		if (url.protocol !== 'magnet:') {
			return null
		}

		// Get xt parameter
		const xt = url.searchParams.get('xt')
		if (!xt) {
			return null
		}

		// Extract info hash from xt parameter
		const matches = xt.match(MAGNET_INFO_HASH_PATTERN)
		return matches ? matches[1] : null
	} catch {
		return null
	}
}
