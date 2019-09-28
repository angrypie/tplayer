import React from 'react'
import { rewindStep } from './store'
import { observer } from 'mobx-react-lite'

export const PlayButtons = observer(({ store }) => {
	const { playing, togglePlaying, getProgress } = store
	const seekForward = () => store.seekTo(getProgress() + rewindStep)
	const seekBackward = () => store.seekTo(getProgress() - rewindStep)
	return (
		<div className='controls flex justify-around items-center'>
			<div className='f3 fw6 pointer' onClick={seekBackward}>
				back
			</div>
			<div className='f2 b pointer' onClick={togglePlaying}>
				{playing ? 'Stop' : 'Play'}
			</div>
			<div className='f3 fw6 pointer' onClick={seekForward}>
				forth
			</div>
		</div>
	)
})
