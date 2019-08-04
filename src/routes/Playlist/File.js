import React, { useState, useEffect } from 'react'
import { getAudio } from './api'
import { Player } from './Player'

export const File = ({ ih, path, length }) => {
	//Set audio obeject URL
	const [audio, setAudio] = useState(null)

	useEffect(() => {
		const download = async () => {
			const url = await getAudio(ih, path)
			setAudio(url)
		}

		if (ih !== undefined && path !== undefined) {
			download()
		}
	}, [ih, path])

	useEffect(
		() => () => {
			//TODO reuse urls in current session
			URL.revokeObjectURL(audio)
		},
		[audio]
	)
	return (
		<Player audio={audio} />
	)
}
