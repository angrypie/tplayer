import { ClipboardPaste } from 'lucide-react'
import type React from 'react'
import { type ChangeEvent, type FormEvent, useId } from 'react'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import type { AudiobookSearchController } from './useAudiobookSearch'

interface SearchProps {
	controller: AudiobookSearchController
}

export const Search: React.FC<SearchProps> = ({ controller }) => {
	const errorId = useId()
	const inputId = useId()
	const isOpening =
		controller.isOpeningDirect || controller.openingResultKey !== null

	const handleSubmit = async (
		event: FormEvent<HTMLFormElement>
	): Promise<void> => {
		event.preventDefault()
		await controller.submit()
	}

	const handlePaste = async (): Promise<void> => {
		try {
			const text = await navigator.clipboard.readText()
			controller.setQuery(text)
		} catch {
			controller.reportError(
				'Unable to read the clipboard. Paste the link into the field.'
			)
		}
	}

	const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
		controller.setQuery(event.currentTarget.value)
	}

	const submitLabel = (() => {
		if (controller.isOpeningDirect) {
			return 'Opening…'
		}
		if (controller.status === 'searching') {
			return 'Searching…'
		}
		return 'search'
	})()

	return (
		<form
			aria-busy={controller.status === 'searching' || isOpening}
			className='w-full'
			onSubmit={handleSubmit}
		>
			<label className='sr-only' htmlFor={inputId}>
				Search audiobooks or paste a magnet link or info hash
			</label>
			<div className='flex h-12 w-full items-center gap-2'>
				<Input
					aria-describedby={controller.error ? errorId : undefined}
					className='min-w-0 flex-1'
					disabled={isOpening}
					id={inputId}
					onChange={handleChange}
					placeholder='audiobook title, magnet link, or info hash'
					type='search'
					value={controller.query}
				/>
				<Button
					aria-label='Paste magnet link or info hash'
					className='h-10 whitespace-nowrap'
					disabled={isOpening}
					onClick={handlePaste}
					type='button'
					variant='outline'
				>
					<ClipboardPaste className='h-4 w-4' />
				</Button>
				<Button
					className='h-10 whitespace-nowrap'
					disabled={isOpening}
					type='submit'
				>
					{submitLabel}
				</Button>
			</div>
			{controller.error ? (
				<p className='px-1 text-destructive text-sm' id={errorId} role='alert'>
					{controller.error}
				</p>
			) : null}
		</form>
	)
}
