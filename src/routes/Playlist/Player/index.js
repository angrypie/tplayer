import React, { useEffect } from 'react'
import { PlayButtons } from './PlayButtons'
import { DurationProgressLine } from './ProgressLines'
import { observer } from 'mobx-react-lite'
import { BottomBar } from './BottomBar'

export const Player = observer(({ audio, store }) => {
	useEffect(() => {
		store.newAudio(audio)
	}, [audio, store])

	return (
		<div className='player flex flex-column justify-around'>
			<DurationProgressLine store={store} />
			<PlayButtons store={store} />
			<div className='side-margin h2 flex items-center m12'>
				<BottomBar store={store} />
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
