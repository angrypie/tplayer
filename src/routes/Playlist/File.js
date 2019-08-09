import React, { useState, useEffect } from 'react'
import { Player } from './Player'
import { observer } from 'mobx-react-lite'

export const File = observer(({ store, playerStore }) => {
	//Set audio obeject URL
	const { ih, getAudio, currentFile } = store
	const [audio, setAudio] = useState(null)

	useEffect(() => {
		const download = async () => {
			const url = await getAudio(currentFile)
			if (url === null) {
				return
			}
			setAudio(url)
		}

		if (ih) {
			download()
		}
	}, [ih, currentFile, getAudio])

	useEffect(
		() => () => {
			//TODO reuse urls in current session
			URL.revokeObjectURL(audio)
		},
		[audio]
	)
	return <Player audio={audio} store={playerStore} />
})
