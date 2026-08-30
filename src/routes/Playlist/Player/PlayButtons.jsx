import { observer } from 'mobx-react-lite'
import { rewindStep } from './store'

export const PlayButtons = observer(({ store }) => {
	const { desiredPlaying, ending, getProgress, hasSource, togglePlaying } =
		store
	const seekForward = () => store.seekTo(getProgress() + rewindStep)
	const seekBackward = () => store.seekTo(getProgress() - rewindStep)
	return (
		<div className='flex items-center justify-around'>
			<button
				className='cursor-pointer border-0 bg-transparent p-0 font-semibold text-2xl'
				onClick={seekBackward}
				type='button'
			>
				back
			</button>
			<button
				className='cursor-pointer border-0 bg-transparent p-0 font-bold text-3xl'
				disabled={!hasSource || ending}
				onClick={togglePlaying}
				type='button'
			>
				{desiredPlaying ? 'Stop' : 'Play'}
			</button>
			<button
				className='cursor-pointer border-0 bg-transparent p-0 font-semibold text-2xl'
				onClick={seekForward}
				type='button'
			>
				forth
			</button>
		</div>
	)
})
