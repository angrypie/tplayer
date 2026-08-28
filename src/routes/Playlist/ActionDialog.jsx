import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'

const FOCUSABLE_SELECTOR =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

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
	const dialogRef = useRef(null)
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

	const handleKeyDown = useCallback(
		(event) => {
			if (event.key === 'Escape') {
				event.preventDefault()
				handleCancel()
				return
			}
			if (event.key !== 'Tab') {
				return
			}

			const focusableElements = Array.from(
				dialogRef.current?.querySelectorAll(FOCUSABLE_SELECTOR) ?? []
			).filter((element) => element.getAttribute('aria-hidden') !== 'true')
			const [firstElement] = focusableElements
			const lastElement = focusableElements.at(-1)
			if (!(firstElement && lastElement)) {
				event.preventDefault()
				return
			}

			const focusIsOutside = !dialogRef.current?.contains(
				document.activeElement
			)
			if (
				event.shiftKey &&
				(document.activeElement === firstElement || focusIsOutside)
			) {
				event.preventDefault()
				lastElement.focus()
				return
			}
			if (
				!event.shiftKey &&
				(document.activeElement === lastElement || focusIsOutside)
			) {
				event.preventDefault()
				firstElement.focus()
			}
		},
		[handleCancel]
	)

	useEffect(() => {
		if (!isOpen) {
			return
		}

		const previousFocus =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null
		const appRoot = document.getElementById('root')
		const previousOverflow = document.body.style.overflow
		if (appRoot) {
			appRoot.inert = true
		}
		document.body.style.overflow = 'hidden'
		document.addEventListener('keydown', handleKeyDown)
		const frame = requestAnimationFrame(() => {
			const focusTarget =
				inputRef.current ?? cancelButtonRef.current ?? dialogRef.current
			focusTarget?.focus()
		})

		return () => {
			cancelAnimationFrame(frame)
			if (appRoot) {
				appRoot.inert = false
			}
			document.body.style.overflow = previousOverflow
			document.removeEventListener('keydown', handleKeyDown)
			previousFocus?.focus()
		}
	}, [handleKeyDown, isOpen])

	if (!isOpen || typeof document === 'undefined') {
		return null
	}

	return createPortal(
		<div className='fixed inset-0 z-[1100] flex items-center justify-center bg-background/70 p-4'>
			<div
				aria-describedby={description ? descriptionId : undefined}
				aria-labelledby={titleId}
				aria-modal='true'
				className='w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-lg'
				ref={dialogRef}
				role='dialog'
				tabIndex={-1}
			>
				<form className='space-y-4' onSubmit={handleSubmit}>
					<div className='space-y-2'>
						<h2 className='font-semibold text-foreground text-lg' id={titleId}>
							{title}
						</h2>
						{description ? (
							<p className='text-muted-foreground text-sm' id={descriptionId}>
								{description}
							</p>
						) : null}
					</div>
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
					<div className='flex justify-end gap-2'>
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
					</div>
				</form>
			</div>
		</div>,
		document.body
	)
}
