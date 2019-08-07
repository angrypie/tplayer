import React from 'react'
import ReactPlayer from 'react-player'
import { observer } from 'mobx-react-lite'

export const ReactPlayerWrapper = observer(({ store }) => {
	const { setDuration, playing, audio, volume } = store

	return (
		<ReactPlayer
			ref={store.playerRef}
			url={audio}
			playing={playing}
			width={'300px'}
			height={'0px'}
			volume={volume}
			config={{ file: { forceAudio: true } }}
			onDuration={setDuration}
		/>
	)
})
