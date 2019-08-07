import React, { useEffect, useRef } from 'react'
import { PlayButtons } from './PlayButtons'
import { DurationProgressLine, VolumeProgressLine } from './ProgressLines'
import { ReactPlayerWrapper } from './ReactPlayerWrapper'
import { observer } from 'mobx-react-lite'
import { usePlayerStore, playerState } from './store'

export const Player = observer(({ audio }) => {
	const playerRef = useRef(null)

	const store = usePlayerStore({ ...playerState, audio })

	useEffect(() => {
		if (store.newAudio(audio)) {
			console.log('new audio', audio)
			store.togglePlaying(true)
		}
	}, [audio, store])

	console.log(store.playing +  '')
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
