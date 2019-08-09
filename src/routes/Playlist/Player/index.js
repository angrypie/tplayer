import React, { useEffect } from 'react'
import { PlayButtons } from './PlayButtons'
import { DurationProgressLine, VolumeProgressLine } from './ProgressLines'
import { observer } from 'mobx-react-lite'

export const Player = observer(({ audio, store }) => {

	useEffect(() => {
		if (store.newAudio(audio)) {
			//store.play()
		}
	}, [audio, store])
	return (
		<div className='player flex flex-column justify-around'>
			<DurationProgressLine store={store} />
			<PlayButtons store={store} />
			<VolumeProgressLine store={store} />
			<div className='flex side-margin'>
				<div className='b'>x1.5</div>
			</div>
			<style jsx>{`
				.player {
					height: 100%;
				}

				.side-margin {
					margin-left: 15px;
					margin-right: 15px;
				}
			`}</style>
		</div>
	)
})
