import React, { useEffect } from 'react'
import { PlayButtons } from './PlayButtons'
import { DurationProgressLine } from './ProgressLines'
import { observer } from 'mobx-react-lite'
import { BottomBar } from './BottomBar'

export const Player = observer(({ audio, store }) => {
	const playerStore = store.playerStore
	useEffect(() => {
		playerStore.newAudio(audio)
	}, [audio, playerStore])

	return (
		<div className='h-full flex flex-col justify-around'>
			<DurationProgressLine store={playerStore} />
			<PlayButtons store={playerStore} />
			<div className='mx-4 h-8 flex items-center'>
				<BottomBar store={store} />
			</div>
		</div>
	)
})
