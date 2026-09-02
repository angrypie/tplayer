import { useCallback, useId, useRef, useState } from 'react'
import { Button } from '~/components/ui/button'
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'

export const ActionDialog = ({
	cancelLabel = 'Cancel',
	confirmLabel = 'Confirm',
	description,
	initialValue = '',
	inputLabel,
	isOpen,
	onCancel,
	onConfirm,
	title,
}) => {
	const [value, setValue] = useState(initialValue)
	const titleId = useId()
	const descriptionId = useId()
	const inputId = useId()
	const cancelButtonRef = useRef(null)
	const inputRef = useRef(null)

	const handleCancel = useCallback(() => {
		setValue(initialValue)
		onCancel()
	}, [initialValue, onCancel])

	const handleChange = useCallback((event) => {
		setValue(event.target.value)
	}, [])

	const handleSubmit = useCallback(
		(event) => {
			event.preventDefault()
			const submittedValue = value
			setValue(initialValue)
			onConfirm(submittedValue)
		},
		[initialValue, onConfirm, value]
	)

	return (
		<Dialog
			describedBy={description ? descriptionId : undefined}
			initialFocusRef={inputLabel ? inputRef : cancelButtonRef}
			isOpen={isOpen}
			onClose={handleCancel}
			titleId={titleId}
		>
			<form className='space-y-4' onSubmit={handleSubmit}>
				<DialogHeader>
					<DialogTitle id={titleId}>{title}</DialogTitle>
					{description ? (
						<DialogDescription id={descriptionId}>
							{description}
						</DialogDescription>
					) : null}
				</DialogHeader>
				{inputLabel ? (
					<div className='space-y-2'>
						<label className='font-medium text-sm' htmlFor={inputId}>
							{inputLabel}
						</label>
						<Input
							id={inputId}
							onChange={handleChange}
							ref={inputRef}
							type='text'
							value={value}
						/>
					</div>
				) : null}
				<DialogFooter>
					<Button
						onClick={handleCancel}
						ref={cancelButtonRef}
						type='button'
						variant='outline'
					>
						{cancelLabel}
					</Button>
					<Button
						disabled={Boolean(inputLabel) && value.trim().length === 0}
						type='submit'
					>
						{confirmLabel}
					</Button>
				</DialogFooter>
			</form>
		</Dialog>
	)
}
