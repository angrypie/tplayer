import { useCallback, useId, useRef, useState } from 'react'
import { ContentUseNotice } from '~/components/ContentUseNotice'
import { Button } from '~/components/ui/button'
import { Checkbox } from '~/components/ui/checkbox'
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '~/components/ui/dialog'
import { CONTENT_USE_ACKNOWLEDGEMENT } from '~/search/contentPolicy'

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

	return (
		<Dialog
			className='max-w-xl'
			describedBy={`${descriptionId} ${noticeId}`}
			initialFocusRef={cancelButtonRef}
			isOpen={isOpen}
			onClose={handleCancel}
			titleId={titleId}
		>
			<form className='space-y-4' onSubmit={handleSubmit}>
				<DialogHeader>
					<DialogTitle id={titleId}>{copy.title}</DialogTitle>
					<DialogDescription id={descriptionId}>
						{copy.description}
					</DialogDescription>
				</DialogHeader>
				<ContentUseNotice id={noticeId} includeThirdParty />
				<div className='flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3'>
					<Checkbox
						checked={acknowledged}
						className='mt-0.5'
						id={checkboxId}
						onChange={handleAcknowledgementChange}
					/>
					<label className='font-medium text-sm' htmlFor={checkboxId}>
						{CONTENT_USE_ACKNOWLEDGEMENT}
					</label>
				</div>
				<DialogFooter>
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
				</DialogFooter>
			</form>
		</Dialog>
	)
}
