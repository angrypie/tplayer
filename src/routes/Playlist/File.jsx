import { observer } from 'mobx-react-lite'
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
				<div
					className='fixed right-5 bottom-5 z-[1200] flex max-w-sm items-center gap-3 rounded-lg bg-black/80 px-4 py-3 text-white'
					role='alert'
				>
					<span className='flex-1'>{notice}</span>
					<button
						aria-label='Dismiss message'
						className='border-0 bg-transparent p-1 text-white'
						onClick={handleDismissNotice}
						type='button'
					>
						×
					</button>
				</div>
			) : null}
		</>
	)
})
