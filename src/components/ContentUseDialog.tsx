import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ContentUseNotice } from '~/components/ContentUseNotice'
import { Button } from '~/components/ui/button'
import { CONTENT_USE_ACKNOWLEDGEMENT } from '~/search/contentPolicy'

const FOCUSABLE_SELECTOR =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export type ContentUseAction = 'enable-tracker' | 'open-direct' | 'open-tracker'

interface ContentUseDialogProps {
	action: ContentUseAction
	isOpen: boolean
	onCancel: () => void
	onConfirm: () => Promise<void> | void
	sourceLabel?: string
}

interface DialogCopy {
	confirmLabel: string
	description: string
	title: string
}

const dialogCopy = (
	action: ContentUseAction,
	sourceLabel?: string
): DialogCopy => {
	if (action === 'enable-tracker') {
		return {
			confirmLabel: 'I understand — enable',
			description: `${sourceLabel ?? 'This source'} is independently operated and its results are not rights-verified by TPlayer. This acknowledgement is remembered in this browser until the policy changes.`,
			title: 'Before enabling an unverified source',
		}
	}
	if (action === 'open-tracker') {
		return {
			confirmLabel: 'I understand — continue',
			description: `Review this once before opening ${sourceLabel ?? 'a result'} from an unverified third-party tracker. TPlayer will remember it in this browser until the policy changes.`,
			title: 'Before opening peer-to-peer content',
		}
	}
	return {
		confirmLabel: 'I understand — continue',
		description:
			'A magnet link or info hash does not prove that its files are authorized. Review this once; TPlayer will remember it in this browser until the policy changes.',
		title: 'Before opening peer-to-peer content',
	}
}

export const ContentUseDialog = ({
	action,
	isOpen,
	onCancel,
	onConfirm,
	sourceLabel,
}: ContentUseDialogProps) => {
	const [acknowledged, setAcknowledged] = useState(false)
	const checkboxId = useId()
	const descriptionId = useId()
	const noticeId = useId()
	const titleId = useId()
	const cancelButtonRef = useRef<HTMLButtonElement>(null)
	const dialogRef = useRef<HTMLDivElement>(null)
	const copy = dialogCopy(action, sourceLabel)

	const handleCancel = useCallback((): void => {
		setAcknowledged(false)
		onCancel()
	}, [onCancel])

	const handleAcknowledgementChange = useCallback(
		(event: React.ChangeEvent<HTMLInputElement>): void => {
			setAcknowledged(event.currentTarget.checked)
		},
		[]
	)

	const handleKeyDown = useCallback(
		(event: KeyboardEvent): void => {
			if (event.key === 'Escape') {
				event.preventDefault()
				handleCancel()
				return
			}
			if (event.key !== 'Tab') {
				return
			}

			const focusableElements = Array.from(
				dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ??
					[]
			).filter((element) => element.getAttribute('aria-hidden') !== 'true')
			const [firstElement] = focusableElements
			// biome-ignore lint/style/useAtIndex: The browser target intentionally predates Array.at.
			const lastElement = focusableElements[focusableElements.length - 1]
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
			setAcknowledged(false)
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
			cancelButtonRef.current?.focus()
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

	const handleSubmit = async (
		event: React.FormEvent<HTMLFormElement>
	): Promise<void> => {
		event.preventDefault()
		if (!acknowledged) {
			return
		}
		setAcknowledged(false)
		await onConfirm()
	}

	return createPortal(
		<div className='fixed inset-0 z-[1100] flex items-center justify-center bg-background/75 p-4'>
			<div
				aria-describedby={`${descriptionId} ${noticeId}`}
				aria-labelledby={titleId}
				aria-modal='true'
				className='max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-auto rounded-lg border border-border bg-card p-5 shadow-xl'
				ref={dialogRef}
				role='dialog'
				tabIndex={-1}
			>
				<form className='space-y-4' onSubmit={handleSubmit}>
					<div className='space-y-2'>
						<h2 className='font-semibold text-foreground text-lg' id={titleId}>
							{copy.title}
						</h2>
						<p className='text-muted-foreground text-sm' id={descriptionId}>
							{copy.description}
						</p>
					</div>
					<ContentUseNotice id={noticeId} includeThirdParty />
					<div className='flex items-start gap-3 rounded-md border border-border p-3'>
						<input
							checked={acknowledged}
							className='mt-0.5 h-4 w-4 shrink-0 accent-primary'
							id={checkboxId}
							onChange={handleAcknowledgementChange}
							type='checkbox'
						/>
						<label className='font-medium text-sm' htmlFor={checkboxId}>
							{CONTENT_USE_ACKNOWLEDGEMENT}
						</label>
					</div>
					<div className='flex justify-end gap-2'>
						<Button
							onClick={handleCancel}
							ref={cancelButtonRef}
							type='button'
							variant='outline'
						>
							Cancel
						</Button>
						<Button disabled={!acknowledged} type='submit'>
							{copy.confirmLabel}
						</Button>
					</div>
				</form>
			</div>
		</div>,
		document.body
	)
}
