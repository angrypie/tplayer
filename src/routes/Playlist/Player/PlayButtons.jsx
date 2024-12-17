import React from 'react'
import { rewindStep } from './store'
import { observer } from 'mobx-react-lite'

export const PlayButtons = observer(({ store }) => {
	const { playing, togglePlaying, getProgress } = store
	const seekForward = () => store.seekTo(getProgress() + rewindStep)
	const seekBackward = () => store.seekTo(getProgress() - rewindStep)
	return (
		<div className='flex justify-around items-center'>
			<div className='text-2xl font-semibold cursor-pointer' onClick={seekBackward}>
				back
			</div>
			<div className='text-3xl font-bold cursor-pointer' onClick={togglePlaying}>
				{playing ? 'Stop' : 'Play'}
			</div>
			<div className='text-2xl font-semibold cursor-pointer' onClick={seekForward}>
				forth
			</div>
		</div>
	)
})
