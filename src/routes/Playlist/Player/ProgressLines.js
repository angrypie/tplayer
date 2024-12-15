import React, { useState, useRef, useEffect } from 'react'
import { numberOrLimit, maxVolume } from './store'
import { observer } from 'mobx-react-lite'

export const DurationProgressLine = observer(({ store }) => {
	const { audio } = store
	const [progress, setProgress] = useState(0)
	const [duration, setDuration] = useState(1)

	useEffect(() => {
		if (!audio) {
			return
		}
		const interval = setInterval(() => {
			setDuration(store.getDuration())
			setProgress(store.getProgress())
		}, 200)
		return () => clearInterval(interval)
	}, [audio, store])
	return (
		<div style={{ margin: '0 15px' }}>
			<ProgressLine
				progress={progress}
				duration={duration}
				setProgress={p => store.seekTo(p)}
				displayMeasures={m => timeFormat(m)}
			/>
		</div>
	)
})

export const VolumeProgressLine = observer(({ store }) => {
	const { changeVolume, setVolume, volume } = store
	const setProgress = v => {
		const volume = Math.round(v * 1e5) / 1e5
		changeVolume(volume)
		setVolume(volume)
	}

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

const ProgressLine = ({ duration, progress, setProgress, displayMeasures }) => {
	const [controlled, setControlled] = useState(false)
	const [position, setPosition] = useState(progress)
	const progressRef = useRef(null)

	useEffect(() => {
		if (!controlled) {
			setPosition(progress)
		}
	}, [progress, controlled])

	//calc returns progress percent value based on duration
	//Use position instead progress to controll this value in component state
	const calc = v => Math.round((v * 10000) / duration) / 100
	const d = calc(duration - position)
	const p = calc(position)

	const touchMove = e => {
		setControlled(true)
		const touch = e.targetTouches[0]
		const x = touch.clientX - progressRef.current.getBoundingClientRect().x
		const w = progressRef.current.offsetWidth
		setPosition(numberOrLimit((x / w) * duration, 0, duration))
	}

	const releaseControll = () => {
		setProgress(position)
		setTimeout(() => setControlled(false), 200)
	}

	const clickSetPosition = e => {
		const x = e.clientX - progressRef.current.getBoundingClientRect().x
		const w = progressRef.current.offsetWidth
		const position = numberOrLimit((x / w) * duration, 0, duration)
		setPosition(position)
		setProgress(position)
		setTimeout(() => setControlled(false), 200)
	}

	return (
		<div
			className='container h2 w-100 flex flex-column justify-center pointer'
			ref={progressRef}
			onTouchMove={touchMove}
			onTouchEnd={releaseControll}
			onClick={clickSetPosition}
		>
			<div className='flex items-center h1'>
				<div style={{ width: `${p}%` }} className='progress'></div>
				<div style={{ width: `${d}%` }} className='duration'></div>
			</div>

			{
				typeof displayMeasures !== 'function' ? null : (
					<div className='flex justify-between'>
						<div className='measure'>{displayMeasures(position)}</div>
						<div className='measure'>-{displayMeasures(duration - position)}</div>
					</div>
				)
			}

			<style jsx>{`
				.progress {
					background: black;
					height: 6px;
				}

				.duration {
					background: black;
					height: 1px;
				}

				.measure {
					font-size: 13px;
					opacity: 0.5;
					font-weight: 500;
				}
			`}</style>
		</div >
	)
}

export function timeFormat(time) {
	time = ~~time
	// Hours, minutes and seconds
	const hrs = ~~(time / 3600)
	const mins = ~~((time % 3600) / 60)
	const secs = ~~time % 60

	let ret = ''

	if (hrs > 0) {
		ret += '' + hrs + ':' + (mins < 10 ? '0' : '')
	}

	ret += '' + mins + ':' + (secs < 10 ? '0' : '')
	ret += '' + secs
	return ret
}
