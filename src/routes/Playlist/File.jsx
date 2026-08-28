import { observer } from 'mobx-react-lite'
import { useEffect, useState } from 'react'
import { cn } from '~/lib/utils'
import { Player } from './Player'

const PRELOAD_STATUS = {
	CANCELLED: 'Cancelled',
	COMPLETE: 'Complete',
	DOWNLOADING: 'Downloading...',
	FAILED: 'Failed',
	PREPARING: 'Preparing to preload...',
}

const PreloadNotification = observer(({ nextFile, getAudio, onComplete }) => {
	const [timeLeft, setTimeLeft] = useState(5)
	const [status, setStatus] = useState(PRELOAD_STATUS.PREPARING)
	const [preloadTimer, setPreloadTimer] = useState(null)
	const [isVisible, setIsVisible] = useState(true)

	useEffect(() => {
		const timer = setTimeout(async () => {
			setStatus(PRELOAD_STATUS.DOWNLOADING)
			try {
				await getAudio(nextFile)
				setStatus(PRELOAD_STATUS.COMPLETE)
				setTimeout(() => {
					setIsVisible(false)
					onComplete()
				}, 1000)
			} catch {
				setStatus(PRELOAD_STATUS.FAILED)
				setTimeout(() => {
					setIsVisible(false)
					onComplete()
				}, 1000)
			}
		}, 5500)

		setPreloadTimer(timer)

		// Start countdown
		const countdownInterval = setInterval(() => {
			setTimeLeft((prev) => {
				if (prev <= 1) {
					clearInterval(countdownInterval)
					return 0
				}
				return prev - 1
			})
		}, 1000)

		return () => {
			clearTimeout(timer)
			clearInterval(countdownInterval)
		}
	}, [nextFile, getAudio, onComplete])

	const handleCancel = () => {
		if (preloadTimer) {
			clearTimeout(preloadTimer)
			setPreloadTimer(null)
		}
		setStatus(PRELOAD_STATUS.CANCELLED)
		setTimeout(() => {
			setIsVisible(false)
			onComplete()
		}, 1000)
	}

	if (!isVisible) {
		return null
	}

	return (
		<div className='fixed right-5 bottom-5 flex min-w-[250px] animate-slide-up items-center gap-4 rounded-lg bg-black/80 px-5 py-2.5 text-white'>
			<div className='flex-1'>
				<div className='mb-1 truncate font-medium'>
					{nextFile.path.join('/')}
				</div>
				<div className='text-sm opacity-80'>
					{status}
					{status === PRELOAD_STATUS.PREPARING && ` (${timeLeft}s)`}
				</div>
			</div>
			<button
				className={cn(
					'whitespace-nowrap rounded bg-[#2f37ff] px-2.5 py-1.5 text-white transition-all hover:bg-[#1f25cc]',
					status !== PRELOAD_STATUS.PREPARING &&
						'pointer-events-none invisible opacity-0'
				)}
				onClick={handleCancel}
				type='button'
			>
				Cancel
			</button>
		</div>
	)
})

export const File = observer(({ store }) => {
	const {
		currentFile,
		getAudio,
		getNextFile,
		ih,
		notice,
		setCurrentFile,
		setNotice,
	} = store
	const [audio, setAudio] = useState(null)
	const [showPreload, setShowPreload] = useState(false)
	const [nextFileToPreload, setNextFileToPreload] = useState(null)

	useEffect(() => {
		const loadAudio = async () => {
			if (!(ih && currentFile.path.length)) {
				return
			}

			try {
				const audioUrl = await getAudio(currentFile)
				if (audioUrl) {
					setAudio(audioUrl)
				} else {
					// If current file fails, try to get next file
					const nextFile = await getNextFile()
					if (nextFile) {
						await setCurrentFile(nextFile)
					}
				}
			} catch (error) {
				console.error('Error loading audio:', error)
			}
		}

		loadAudio()
	}, [ih, currentFile, getAudio, getNextFile, setCurrentFile])

	useEffect(
		() => () => {
			URL.revokeObjectURL(audio)
		},
		[audio]
	)

	useEffect(() => {
		const downloadNextAndSet = async () => {
			if (nextFileToPreload) {
				const url = await getAudio(nextFileToPreload)
				if (url === null) {
					return
				}
				setAudio(url)
			}
		}

		if (nextFileToPreload) {
			downloadNextAndSet()
		}
	}, [nextFileToPreload, getAudio])

	useEffect(() => {
		const checkIfShouldPreloadNext = async () => {
			if (currentFile && !currentFile.cached) {
				const nextFile = await getNextFile()
				if (nextFile && !nextFile.cached) {
					setNextFileToPreload(nextFile)
					setShowPreload(true)
				}
			}
		}

		if (ih) {
			checkIfShouldPreloadNext()
		}
	}, [ih, currentFile, getNextFile])

	const handlePreloadComplete = () => {
		setShowPreload(false)
		setNextFileToPreload(null)
	}

	const handleDismissNotice = () => {
		setNotice(null)
	}

	return (
		<>
			<Player audio={audio} store={store} />
			{notice ? (
				<div
					className='fixed right-5 bottom-5 z-[1200] flex max-w-sm items-center gap-3 rounded-lg bg-black/80 px-4 py-3 text-white'
					role='alert'
				>
					<span className='flex-1'>{notice}</span>
					<button
						aria-label='Dismiss message'
						className='border-0 bg-transparent p-1 text-white'
						onClick={handleDismissNotice}
						type='button'
					>
						×
					</button>
				</div>
			) : null}
			{showPreload && nextFileToPreload ? (
				<PreloadNotification
					getAudio={getAudio}
					nextFile={nextFileToPreload}
					onComplete={handlePreloadComplete}
				/>
			) : null}
		</>
	)
})
