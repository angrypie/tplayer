import { Pause, Play, RotateCcw, RotateCw } from 'lucide-react'
import { observer } from 'mobx-react-lite'
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
			<button
				aria-label={backwardLabel}
				className='grid size-12 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-foreground transition-colors hover:bg-accent/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-30'
				disabled={controlsDisabled}
				onClick={seekBackward}
				title={backwardLabel}
				type='button'
			>
				<JumpIcon direction='backward' />
			</button>
			<button
				aria-label={desiredPlaying ? 'Pause' : 'Play'}
				className='grid size-14 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-foreground transition-colors hover:bg-accent/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:bg-accent disabled:pointer-events-none disabled:opacity-30'
				disabled={controlsDisabled}
				onClick={togglePlaying}
				title={desiredPlaying ? 'Pause' : 'Play'}
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
			</button>
			<button
				aria-label={forwardLabel}
				className='grid size-12 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-foreground transition-colors hover:bg-accent/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-30'
				disabled={controlsDisabled}
				onClick={seekForward}
				title={forwardLabel}
				type='button'
			>
				<JumpIcon direction='forward' />
			</button>
		</div>
	)
})
