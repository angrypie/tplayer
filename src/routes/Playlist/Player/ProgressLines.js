import React, { useState, useRef, useEffect } from 'react'
import { numberOrLimit, maxVolume } from './store'
import { observer } from 'mobx-react-lite'

export const DurationProgressLine = observer(({ store }) => {
	const { progress, duration } = store
	return (
		<ProgressLine
			progress={progress}
			duration={duration}
			setProgress={p => store.seekTo(p)}
		/>
	)
})

export const VolumeProgressLine = observer(({ store }) => {
	const { setVolume, volume } = store
	const setProgress = v =>
		setVolume(numberOrLimit(Math.round(v * 1e5) / 1e5, 0, 1))

	return (
		<div style={{ margin: '0 30px' }}>
			<ProgressLine
				progress={volume}
				duration={maxVolume}
				setProgress={setProgress}
			/>
		</div>
	)
})

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
