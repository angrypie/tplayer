import { X } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import { Player } from './Player'

export const File = observer(({ store }) => {
	const { notice, setNotice } = store

	const handleDismissNotice = () => {
		setNotice(null)
	}

	return (
		<>
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
		</>
	)
})
