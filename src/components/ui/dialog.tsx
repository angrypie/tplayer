import {
	type ComponentProps,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '~/lib/utils'

const FOCUSABLE_SELECTOR =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface DialogProps extends ComponentProps<'div'> {
	describedBy?: string
	initialFocusRef?: RefObject<HTMLElement | null>
	isOpen: boolean
	onClose: () => void
	titleId: string
}

export const Dialog = ({
	children,
	className,
	describedBy,
	initialFocusRef,
	isOpen,
	onClose,
	titleId,
	...props
}: DialogProps) => {
	const dialogRef = useRef<HTMLDivElement>(null)

	const handleKeyDown = useCallback(
		(event: KeyboardEvent): void => {
			if (event.key === 'Escape') {
				event.preventDefault()
				onClose()
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
		[onClose]
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
			initialFocusRef?.current?.focus()
			if (!initialFocusRef?.current) {
				dialogRef.current?.focus()
			}
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
	}, [handleKeyDown, initialFocusRef, isOpen])

	if (!isOpen || typeof document === 'undefined') {
		return null
	}

	return createPortal(
		<div className='fixed inset-0 z-[1100] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm'>
			<div
				aria-describedby={describedBy}
				aria-labelledby={titleId}
				aria-modal='true'
				className={cn(
					'max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-xl border border-border bg-card p-5 text-card-foreground shadow-2xl sm:p-6',
					className
				)}
				ref={dialogRef}
				role='dialog'
				tabIndex={-1}
				{...props}
			>
				{children}
			</div>
		</div>,
		document.body
	)
}

export const DialogHeader = ({
	className,
	...props
}: ComponentProps<'div'>) => (
	<div className={cn('space-y-1.5', className)} {...props} />
)

export const DialogTitle = ({ className, ...props }: ComponentProps<'h2'>) => (
	<h2
		className={cn('font-semibold text-lg tracking-tight', className)}
		{...props}
	/>
)

export const DialogDescription = ({
	className,
	...props
}: ComponentProps<'p'>) => (
	<p
		className={cn('text-muted-foreground text-sm leading-relaxed', className)}
		{...props}
	/>
)

export const DialogFooter = ({
	className,
	...props
}: ComponentProps<'div'>) => (
	<div
		className={cn(
			'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end',
			className
		)}
		{...props}
	/>
)
