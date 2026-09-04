import { X } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import { cn } from '~/lib/utils'
import { Player } from './Player'

export const File = observer(({ store }) => {
	const { notice, playerStore, setNotice } = store

	const handleDismissNotice = () => {
		setNotice(null)
	}

	return (
		<div
			className={cn(
				'shrink-0 border-border/70 border-t bg-card/95 transition-[height] duration-200 motion-reduce:transition-none',
				playerStore.liveCaptionsEnabled ? 'h-96' : 'h-44'
			)}
		>
			<Player store={store} />
			{notice ? (
				<Alert
					className='pointer-events-none fixed right-4 bottom-4 z-[1200] flex max-w-sm items-center gap-3 bg-popover shadow-xl'
					role='status'
				>
					<AlertDescription className='flex-1 text-popover-foreground'>
						{notice}
					</AlertDescription>
					<Button
						aria-label='Dismiss message'
						className='pointer-events-auto shrink-0'
						onClick={handleDismissNotice}
						size='icon'
						type='button'
						variant='ghost'
					>
						<X aria-hidden='true' />
					</Button>
				</Alert>
			) : null}
		</div>
	)
})
