import React, { useState, useEffect } from 'react'
import { Player } from './Player'
import { observer } from 'mobx-react-lite'
import { cn } from '~/lib/utils'

const PRELOAD_STATUS = {
    PREPARING: 'Preparing to preload...',
    DOWNLOADING: 'Downloading...',
    COMPLETE: 'Complete',
    FAILED: 'Failed',
    CANCELLED: 'Cancelled'
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
            } catch (error) {
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
            setTimeLeft(prev => {
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

    if (!isVisible) return null

    return (
        <div className="fixed bottom-5 right-5 bg-black/80 text-white px-5 py-2.5 rounded-lg flex gap-4 items-center min-w-[250px] animate-slide-up">
            <div className="flex-1">
                <div className="font-medium mb-1 truncate">
                    {nextFile.path.join('/')}
                </div>
                <div className="text-sm opacity-80">
                    {status}
                    {status === PRELOAD_STATUS.PREPARING && ` (${timeLeft}s)`}
                </div>
            </div>
            <button 
                onClick={handleCancel}
                className={cn(
                    "bg-[#2f37ff] text-white px-2.5 py-1.5 rounded whitespace-nowrap transition-all hover:bg-[#1f25cc]",
                    status !== PRELOAD_STATUS.PREPARING && "opacity-0 invisible pointer-events-none"
                )}
            >
                Cancel
            </button>
        </div>
    )
})

export const File = observer(({ store }) => {
    const { ih, getAudio, currentFile, getNextFile } = store
    const [audio, setAudio] = useState(null)
    const [showPreload, setShowPreload] = useState(false)
    const [nextFileToPreload, setNextFileToPreload] = useState(null)

    useEffect(() => {
        const loadAudio = async () => {
            if (!ih || !currentFile.path.length) {
                return
            }

            try {
                const audio = await getAudio(currentFile)
                if (audio) {
                    setAudio(audio)
                } else {
                    // If current file fails, try to get next file
                    const nextFile = await getNextFile()
                    if (nextFile) {
                        await store.setCurrentFile(nextFile)
                    }
                }
            } catch (error) {
                console.error('Error loading audio:', error)
            }
        }

        loadAudio()
    }, [ih, currentFile, getAudio, getNextFile])

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

    return (
        <>
            <Player audio={audio} store={store} />
            {showPreload && nextFileToPreload && (
                <PreloadNotification 
                    nextFile={nextFileToPreload}
                    getAudio={getAudio}
                    onComplete={handlePreloadComplete}
                />
            )}
        </>
    )
})
