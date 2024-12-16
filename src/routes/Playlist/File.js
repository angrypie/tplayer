import React, { useState, useEffect } from 'react'
import { Player } from './Player'
import { observer } from 'mobx-react-lite'

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
        <div className="preload-notification">
            <div className="content">
                <div className="file-name">{nextFile.path.join('/')}</div>
                <div className="status">
                    {status}
                    {status === PRELOAD_STATUS.PREPARING && ` (${timeLeft}s)`}
                </div>
            </div>
            <button 
                onClick={handleCancel}
                className={status !== PRELOAD_STATUS.PREPARING ? 'hidden' : ''}
            >
                Cancel
            </button>
            <style jsx>{`
                .preload-notification {
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    background: rgba(0, 0, 0, 0.8);
                    color: white;
                    padding: 10px 20px;
                    border-radius: 8px;
                    display: flex;
                    gap: 15px;
                    align-items: center;
                    animation: slide-up 0.3s ease;
                    min-width: 250px;
                }
                .content {
                    flex: 1;
                }
                .file-name {
                    font-weight: 500;
                    margin-bottom: 4px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .status {
                    font-size: 0.9em;
                    opacity: 0.8;
                }
                button {
                    background: #2f37ff;
                    border: none;
                    color: white;
                    padding: 5px 10px;
                    border-radius: 4px;
                    cursor: pointer;
                    white-space: nowrap;
                    transition: opacity 0.2s ease, visibility 0.2s ease;
                }
                button.hidden {
                    opacity: 0;
                    visibility: hidden;
                    pointer-events: none;
                }
                button:hover {
                    background: #1f25cc;
                }
                @keyframes slide-up {
                    from { transform: translateY(100px); opacity: 0; }
                    to { transform: translateY(0); opacity: 1; }
                }
            `}</style>
        </div>
    )
})

export const File = observer(({ store }) => {
    const { ih, getAudio, currentFile, getNextFile } = store
    const [audio, setAudio] = useState(null)
    const [showPreload, setShowPreload] = useState(false)
    const [nextFileToPreload, setNextFileToPreload] = useState(null)

    useEffect(() => {
        const downloadCurrentAndSet = async () => {
            const url = await getAudio(currentFile)
            if (url === null) {
                return
            }
            setAudio(url)
            
            // Check if we should start preloading next file
            const nextFile = getNextFile()
            if (nextFile && !nextFile.cached) {
                setNextFileToPreload(nextFile)
                setShowPreload(true)
            }
        }

        if (ih) {
            downloadCurrentAndSet()
        }
    }, [ih, currentFile, getAudio, getNextFile])

    useEffect(
        () => () => {
            URL.revokeObjectURL(audio)
        },
        [audio]
    )

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
