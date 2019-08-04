import React, { useState, useEffect, useRef } from 'react'
import ReactPlayer from 'react-player'

const maxVolume = 1
const configDefaults = {
	playing: false,
	duration: 100,
	progress: 0,
	volume: 0.7,
}

export const Player = ({ audio }) => {
	const [config, setConfig] = useState(configDefaults)
	const playerRef = useRef(null)
	const { playing, progress, duration, volume } = config

	//change config helper
	const cc = key => value => () => setConfig(c => ({ ...c, [key]: value }))
	const togglePlay = cc('playing')(!audio ? false : !playing)
	const setProgress = cc('progress')
	const setDuration = cc('duration')

	const player = playerRef.current
	const seekForward = () => player.seekTo(progress + 15)
	const seekBackward = () => player.seekTo(progress - 15)

	useEffect(() => {
		if (!!audio) {
			setConfig(c => ({ ...c, playing: true }))
		}
	}, [audio])
	return (
		<div className='player flex flex-column justify-around'>
			<ReactPlayer
				ref={playerRef}
				url={audio}
				playing={playing}
				width={'300px'}
				height={'0px'}
				volume={volume}
				config={{ file: { forceAudio: true } }}
				onProgress={p => setProgress(p.playedSeconds)()}
				onDuration={d => setDuration(d)()}
			/>
			<ProgressLine progress={progress} duration={duration} />

			<div className='controls flex justify-around items-center'>
				<div className='f3 fw6 pointer' onClick={seekBackward}>
					back
				</div>
				<div className='f2 b pointer' onClick={togglePlay}>
					{playing ? 'Stop' : 'Play'}
				</div>
				<div className='f3 fw6 pointer' onClick={seekForward}>
					forth
				</div>
			</div>
			<div className='sound-control'>
				<ProgressLine progress={volume} duration={maxVolume} />
			</div>
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

				.sound-control {
					margin-left: 30px;
					margin-right: 30px;
				}
			`}</style>
		</div>
	)
}

const ProgressLine = ({ duration, progress }) => {
	//calc returns progress percent value based on duration
	const calc = v => Math.round((v * 10000) / duration) / 100
	const d = calc(duration - progress)
	const p = calc(progress)
	return (
		<div className='container flex items-center'>
			<div style={{ width: `${p}%` }} className='progress'></div>
			<div style={{ width: `${d}%` }} className='duration'></div>
			<style jsx>{`
				.progress {
					background: black;
					height: 5px;
				}

				.duration {
					background: black;
					height: 1px;
				}
			`}</style>
		</div>
	)
}
