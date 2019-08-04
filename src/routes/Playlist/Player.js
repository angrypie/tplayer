import React, { useState, useEffect, useRef } from 'react'
import ReactPlayer from 'react-player'

const maxVolume = 1
const rewindStep = 30
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
	const setVolume = v => cc('volume')(numberOrLimit(v, 0, 1))()

	const player = playerRef.current
	const seekTo = p => player.seekTo(numberOrLimit(p, 0, duration))
	const seekForward = () => seekTo(progress + rewindStep)
	const seekBackward = () => seekTo(progress - rewindStep)

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
				progressInterval={100}
			/>
			<ProgressLine
				progress={progress}
				duration={duration}
				setProgress={seekTo}
			/>
			<PlayButtons {...{ playing, togglePlay, seekForward, seekBackward }} />
			<div style={{ margin: '0 30px' }}>
				<ProgressLine
					progress={volume}
					duration={maxVolume}
					setProgress={setVolume}
				/>
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

const ProgressLine = ({ duration, progress, setProgress }) => {
	const [controlled, setControlled] = useState(false)
	const [position, setPosition] = useState(progress)
	const progressRef = useRef(null)

	useEffect(() => {
		if (controlled) {
			return
		}
		setPosition(progress)
	}, [progress, controlled])

	//calc returns progress percent value based on duration
	const calc = v => Math.round((v * 10000) / duration) / 100
	const d = calc(duration - position)
	const p = calc(position)
	const touchMove = e => {
		setControlled(true)
		const touch = e.targetTouches[0]
		const x = touch.clientX - progressRef.current.getBoundingClientRect().x
		const w = progressRef.current.offsetWidth
		const nd = (x / w) * duration
		setPosition(nd)
	}

	const releaseControll = e => {
		setProgress(position)
		setTimeout(() => setControlled(false), 200)
	}

	return (
		<div
			className='container flex items-center h2'
			ref={progressRef}
			onTouchMove={touchMove}
			onTouchEnd={releaseControll}
		>
			<div style={{ width: `${p}%` }} className='progress'></div>
			<div style={{ width: `${d}%` }} className='duration'></div>
			<style jsx>{`
				.container {
					width: 100%;
				}
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

const PlayButtons = ({ playing, togglePlay, seekForward, seekBackward }) => {
	return (
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
	)
}

//returns 'n' if it betweens 'a' and 'b' limits, or else closest limit.
const numberOrLimit = (n, a, b) => (n < a ? a : n > b ? b : n)
