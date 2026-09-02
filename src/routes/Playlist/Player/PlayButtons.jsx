import { Pause, Play, RotateCcw, RotateCw } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { Button } from '~/components/ui/button'
import { playbackJumpSeconds } from './store'

const JumpIcon = ({ direction }) => {
	const Icon = direction === 'backward' ? RotateCcw : RotateCw
	return (
		<span
			aria-hidden='true'
			className='relative grid size-9 place-items-center'
		>
			<Icon className='absolute inset-0 size-9' strokeWidth={1.75} />
			<span className='pt-0.5 font-semibold text-[10px] tabular-nums leading-none'>
				{playbackJumpSeconds}
			</span>
		</span>
	)
}

export const PlayButtons = observer(({ store }) => {
	const { desiredPlaying, ending, getProgress, hasSource, togglePlaying } =
		store
	const controlsDisabled = !hasSource || ending
	const seekForward = () => store.seekTo(getProgress() + playbackJumpSeconds)
	const seekBackward = () => store.seekTo(getProgress() - playbackJumpSeconds)
	const backwardLabel = `Back ${playbackJumpSeconds} seconds`
	const forwardLabel = `Forward ${playbackJumpSeconds} seconds`
	return (
		<div className='flex items-center justify-center gap-8'>
			<Button
				aria-label={backwardLabel}
				className='size-12 rounded-full'
				disabled={controlsDisabled}
				onClick={seekBackward}
				size='icon'
				type='button'
				variant='ghost'
			>
				<JumpIcon direction='backward' />
			</Button>
			<Button
				aria-label={desiredPlaying ? 'Pause' : 'Play'}
				className='size-14 rounded-full shadow-md'
				disabled={controlsDisabled}
				onClick={togglePlaying}
				size='icon'
				type='button'
			>
				{desiredPlaying ? (
					<Pause aria-hidden='true' className='size-9' strokeWidth={1.75} />
				) : (
					<Play
						aria-hidden='true'
						className='ml-0.5 size-9'
						strokeWidth={1.75}
					/>
				)}
			</Button>
			<Button
				aria-label={forwardLabel}
				className='size-12 rounded-full'
				disabled={controlsDisabled}
				onClick={seekForward}
				size='icon'
				type='button'
				variant='ghost'
			>
				<JumpIcon direction='forward' />
			</Button>
		</div>
	)
})
