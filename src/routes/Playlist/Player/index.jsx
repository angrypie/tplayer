import { observer } from 'mobx-react-lite'
import { useEffect } from 'react'
import { BottomBar } from './BottomBar'
import { PlayButtons } from './PlayButtons'
import { DurationProgressLine } from './ProgressLines'

export const Player = observer(({ audio, store }) => {
	const { playerStore } = store
	useEffect(() => {
		playerStore.newAudio(audio)
	}, [audio, playerStore])

	return (
		<div className='flex h-full flex-col justify-around'>
			<DurationProgressLine store={playerStore} />
			<PlayButtons store={playerStore} />
			<div className='mx-4 flex h-8 items-center'>
				<BottomBar store={store} />
			</div>
		</div>
	)
})
