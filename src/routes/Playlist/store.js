import { runInAction, toJS } from 'mobx'
import { useLocalObservable } from 'mobx-react-lite'
import React from 'react'
import { storage } from '~/storage'
import {
	comparePath,
	getAudioFormat,
	isAudioFile,
	naturalCompare,
	normalizePath,
} from '~/utils'
import { downloadFileForOffline, getPlayableUrl, getTorrentInfo } from './api'
import { usePlayerStore } from './Player/store'

export const COMBINED_FILES_PREFIX = 'combined_Joh1thoh'

const COMBINED_RANGE_PATTERN = /^(\d+)-(\d+)$/
const RESUME_SAVE_INTERVAL_MS = 3000
const emptyCurrentFile = () => ({ id: '', path: [] })
const emptyTorrentInfo = () => ({
	files: [],
	length: 0,
	name: '',
	state: undefined,
})
const ignoreFailure = () => undefined

const pathKey = (path) => normalizePath(path).join('/')

const storedPathParts = (path) => {
	const normalized = normalizePath(path)
	if (normalized.length === 1) {
		return normalized[0].split('/').filter(Boolean)
	}
	return normalized
}

const findOriginalFile = (torrentFiles, storedFile, storedPath) =>
	torrentFiles.find((torrentFile) => {
		if (storedFile.id && torrentFile.id === storedFile.id) {
			return true
		}
		return pathKey(torrentFile.path) === storedPath
	})

const combinedIndexes = (pathParts) => {
	const match = pathParts[1]?.match(COMBINED_RANGE_PATTERN)
	if (!match) {
		return null
	}
	const startIndex = Number(match[1])
	const endIndex = Number(match[2])
	if (startIndex > endIndex) {
		return null
	}
	return [startIndex, endIndex]
}

const cachedOriginalFile = (
	torrentFiles,
	storedFile,
	pathParts,
	storedPath
) => {
	const originalFile = findOriginalFile(torrentFiles, storedFile, storedPath)
	return {
		...originalFile,
		cached: true,
		id: originalFile?.id ?? storedFile.id ?? storedPath,
		length: originalFile?.length ?? storedFile.file.size,
		mimeType: originalFile?.mimeType ?? storedFile.file.type,
		name: originalFile?.name ?? pathParts.at(-1) ?? storedPath,
		path: originalFile?.path ?? pathParts,
		state: 'ready',
	}
}

const hideCombinedOriginals = (indexes, torrentFiles, hiddenFiles) => {
	if (!indexes) {
		return
	}
	const [startIndex, endIndex] = indexes
	for (let index = startIndex; index <= endIndex; index += 1) {
		const originalFile = torrentFiles[index]
		if (originalFile) {
			hiddenFiles.add(pathKey(originalFile.path))
		}
	}
}

const cachedCombinedFile = (storedFile, pathParts, storedPath, indexes) => ({
	cached: true,
	id: storedFile.id ?? storedPath,
	isCombined: true,
	length: storedFile.file.size,
	mimeType: storedFile.file.type || 'audio/mpeg',
	name: pathParts.at(-1) ?? storedPath,
	originalIndexes: indexes ?? [0, 0],
	path: pathParts,
	state: 'ready',
})

const collectStoredFileState = (files, torrentFiles) => {
	const storedPaths = new Set()
	const hiddenFiles = new Set()
	const allFiles = []

	for (const storedFile of files) {
		const pathParts = storedPathParts(storedFile.path)
		const storedPath = pathParts.join('/')
		storedPaths.add(storedPath)
		if (pathParts[0] !== COMBINED_FILES_PREFIX) {
			allFiles.push(
				cachedOriginalFile(torrentFiles, storedFile, pathParts, storedPath)
			)
			continue
		}

		const indexes = combinedIndexes(pathParts)
		hideCombinedOriginals(indexes, torrentFiles, hiddenFiles)
		allFiles.push(
			cachedCombinedFile(storedFile, pathParts, storedPath, indexes)
		)
	}

	return { allFiles, hiddenFiles, storedPaths }
}

const releaseUrl = (url) => {
	if (typeof url === 'string' && url.length > 0) {
		URL.revokeObjectURL(url)
	}
}

const playbackTime = (value) => {
	const numericValue = Number(value)
	return Number.isFinite(numericValue) ? Math.max(0, numericValue) : 0
}

const isCurrentSourceRequest = (store, requestId) =>
	requestId === store.sourceRequestId && !store.disposed

const isCurrentMetadataRequest = (store, requestId) =>
	requestId === store.metadataRequestId && !store.disposed

const persistSnapshotSafely = async (store, snapshot, failureMessage) => {
	try {
		await store.persistResumeSnapshot(snapshot)
		return true
	} catch {
		store.setNotice(failureMessage)
		return false
	}
}

const reuseCurrentSource = (store, file, state, options, resumeTime) => {
	const isSameSource =
		comparePath(file.path, store.currentFile.path) &&
		store.playerStore.audio &&
		!store.playerStore.error
	if (!isSameSource) {
		return false
	}
	if (state?.time !== undefined) {
		store.playerStore.seekTo(resumeTime)
	}
	if (options.autoplay) {
		store.playerStore.play()
	}
	return true
}

const beginSourceChange = (store, options) => {
	const requestId = store.sourceRequestId + 1
	store.sourceRequestId = requestId
	return {
		previousSnapshot: options.skipFlush ? null : store.createResumeSnapshot(),
		requestId,
		shouldAutoplay: Boolean(options.autoplay || store.playerStore.playing),
	}
}

const resolvePlayableSource = async (store, file, requestId) => {
	try {
		const url = await getPlayableUrl(store.ih, file)
		if (!isCurrentSourceRequest(store, requestId)) {
			releaseUrl(url)
			return null
		}
		return url
	} catch (error) {
		if (isCurrentSourceRequest(store, requestId)) {
			runInAction(() => {
				file.state = 'ready'
			})
			store.handlePlaybackError(error)
		}
		return null
	}
}

const activatePlayableSource = (
	store,
	file,
	url,
	resumeTime,
	shouldAutoplay
) => {
	runInAction(() => {
		file.state = 'ready'
		store.currentFile = file
	})
	store.playerStore.loadSource({
		autoplay: shouldAutoplay,
		format: getAudioFormat(file),
		resumeTime,
		url,
	})
}

const prepareTorrentSwitch = async (store, infoHash, requestId) => {
	if (infoHash === store.ih) {
		return true
	}
	const snapshot = store.createResumeSnapshot()
	store.sourceRequestId += 1
	await persistSnapshotSafely(
		store,
		snapshot,
		'Unable to save the previous playback position.'
	)
	if (!isCurrentMetadataRequest(store, requestId)) {
		return false
	}
	store.playerStore.clearSource()
	runInAction(() => {
		store.currentFile = emptyCurrentFile()
		store.ih = infoHash
		store.torrentInfo = emptyTorrentInfo()
	})
	return true
}

const requestTorrentInfo = async (store, infoHash, requestId) => {
	try {
		const info = await getTorrentInfo(infoHash)
		return isCurrentMetadataRequest(store, requestId) ? info : null
	} catch (error) {
		if (isCurrentMetadataRequest(store, requestId)) {
			store.handlePlaybackError(error)
		}
		return null
	}
}

const normalizeTorrentInfo = (info) => {
	const files = [...(info.files ?? [])]
	files.sort((a, b) => naturalCompare(pathKey(a.path), pathKey(b.path)))
	return {
		files,
		length: info.length ?? 0,
		name: info['name.utf-8'] ?? info.name ?? '',
		state: info.state,
	}
}

const resumeSavedFile = async (store, torrentInfo, infoHash, requestId) => {
	const savedState = torrentInfo.state
	if (!savedState?.path) {
		return
	}
	let playableFiles = torrentInfo.files
	try {
		playableFiles = await store.getAllTorrentFiles(infoHash, torrentInfo.files)
	} catch (error) {
		store.handlePlaybackError(error)
	}
	if (!isCurrentMetadataRequest(store, requestId)) {
		return
	}
	const resumedFile = playableFiles.find(
		(file) => isAudioFile(file) && comparePath(file.path, savedState.path)
	)
	if (resumedFile) {
		await store.setCurrentFile(resumedFile, savedState)
	}
}

export const useBookStores = ({ ih }) => {
	const playerStore = usePlayerStore()
	const bookStore = useBookStore({ ih, playerStore })

	React.useEffect(
		() => () => {
			bookStore.dispose().catch(ignoreFailure)
		},
		[bookStore]
	)

	return {
		bookStore,
		playerStore,
	}
}

export const useBookStore = ({ ih: initialInfoHash, playerStore }) => {
	const store = useLocalObservable(() => ({
		async cleanBookData(infoHash) {
			const snapshot = store.createResumeSnapshot()
			store.sourceRequestId += 1
			store.playerStore.clearSource()
			store.currentFile = emptyCurrentFile()
			await store.persistResumeSnapshot(snapshot)
			const result = await storage.removeFilesByIh(infoHash)
			if (result) {
				store.filesVersion += 1
				await store.setTorrentInfo(infoHash)
			}
			return result
		},

		createResumeSnapshot(timeOverride) {
			const currentPath = normalizePath(toJS(store.currentFile.path))
			if (!(store.ih && store.playerStore.audio && currentPath.length > 0)) {
				return null
			}
			const time =
				timeOverride === undefined
					? store.playerStore.getProgress()
					: timeOverride
			return {
				infoHash: store.ih,
				state: {
					path: currentPath,
					time: playbackTime(time),
					updatedAt: Date.now(),
				},
			}
		},
		currentFile: emptyCurrentFile(),

		async dispose() {
			if (store.disposed) {
				return
			}
			store.disposed = true
			store.metadataRequestId += 1
			store.sourceRequestId += 1
			const snapshot = store.createResumeSnapshot()
			store.playerStore.dispose()
			await store.persistResumeSnapshot(snapshot)
		},
		disposed: false,

		async downloadAllFiles() {
			const { ih: infoHash, torrentInfo } = store
			if (!(infoHash && torrentInfo.files.length)) {
				return false
			}

			const filesToDownload = torrentInfo.files.filter((file) => !file.cached)
			if (filesToDownload.length === 0) {
				return true
			}

			let failedCount = 0
			for (const file of filesToDownload) {
				runInAction(() => {
					file.state = 'loading'
				})
				try {
					// biome-ignore lint/performance/noAwaitInLoops: Sequential full-file downloads keep peak browser memory bounded.
					await downloadFileForOffline(infoHash, file)
					runInAction(() => {
						file.cached = true
						file.state = 'ready'
					})
				} catch {
					failedCount += 1
					runInAction(() => {
						file.state = 'ready'
					})
				}
			}
			runInAction(() => {
				store.filesVersion += 1
				if (failedCount > 0) {
					store.setNotice(
						`${failedCount} file${failedCount === 1 ? '' : 's'} could not be downloaded.`
					)
				}
			})
			return failedCount === 0
		},
		filesVersion: 0,

		async getAllTorrentFiles(
			infoHash = store.ih,
			torrentFiles = store.torrentInfo.files
		) {
			const files = await storage.getAllFilesForTorrent(infoHash)
			const { allFiles, hiddenFiles, storedPaths } = collectStoredFileState(
				files,
				torrentFiles
			)

			for (const file of torrentFiles) {
				const filePath = pathKey(file.path)
				if (!(storedPaths.has(filePath) || hiddenFiles.has(filePath))) {
					allFiles.push(file)
				}
			}

			return allFiles
		},

		async getNextFile() {
			const files = (await store.getAllTorrentFiles()).filter(isAudioFile)
			const currentIndex = files.findIndex(({ path }) =>
				comparePath(path, store.currentFile.path)
			)
			return currentIndex >= 0 ? files[currentIndex + 1] : undefined
		},

		async handlePlaybackEnd({ currentTime, duration } = {}) {
			const requestId = store.sourceRequestId
			const finalTime = Math.max(
				playbackTime(currentTime),
				playbackTime(duration)
			)
			await persistSnapshotSafely(
				store,
				store.createResumeSnapshot(finalTime),
				'Unable to save the finished chapter position.'
			)
			if (requestId !== store.sourceRequestId || store.disposed) {
				return
			}
			const nextFile = await store.getNextFile()
			if (requestId !== store.sourceRequestId || store.disposed) {
				return
			}
			if (!nextFile) {
				store.playerStore.finishPlayback()
				return
			}
			await store.setCurrentFile(nextFile, undefined, {
				autoplay: true,
				skipFlush: true,
			})
		},

		handlePlaybackError(error) {
			store.setNotice(error instanceof Error ? error.message : String(error))
		},
		ih: initialInfoHash,
		metadataRequestId: 0,
		notice: null,

		async persistResumeSnapshot(snapshot) {
			if (!snapshot) {
				return false
			}
			await storage.updateTorrent(snapshot.infoHash, { state: snapshot.state })
			return true
		},
		playerStore,

		async removeBook(infoHash) {
			store.metadataRequestId += 1
			store.sourceRequestId += 1
			store.playerStore.clearSource()
			store.currentFile = emptyCurrentFile()
			return await storage.removeFilesAndTorrent(infoHash)
		},

		async removeFile(infoHash, file) {
			if (comparePath(file.path, store.currentFile.path)) {
				await store.saveCurrentPlaying({ force: true })
				store.sourceRequestId += 1
				store.playerStore.clearSource()
				store.currentFile = emptyCurrentFile()
			}
			const success = await storage.removeFile(infoHash, pathKey(file.path))
			if (success) {
				runInAction(() => {
					file.cached = false
					file.state = 'ready'
					store.filesVersion += 1
				})
			}
			return success
		},

		async saveCurrentPlaying({ force = false } = {}) {
			if (!(force || store.playerStore.playing)) {
				return false
			}
			return await store.persistResumeSnapshot(store.createResumeSnapshot())
		},

		async setCurrentFile(file, state, options = {}) {
			if (!(file && isAudioFile(file))) {
				store.setNotice('This file is not a supported audio format.')
				return false
			}

			const resumeTime = playbackTime(state?.time)
			if (reuseCurrentSource(store, file, state, options, resumeTime)) {
				return true
			}

			const { previousSnapshot, requestId, shouldAutoplay } = beginSourceChange(
				store,
				options
			)
			await persistSnapshotSafely(
				store,
				previousSnapshot,
				'Unable to save the previous playback position.'
			)
			if (!isCurrentSourceRequest(store, requestId)) {
				return false
			}

			runInAction(() => {
				file.state = 'loading'
			})
			const url = await resolvePlayableSource(store, file, requestId)
			if (!url) {
				return false
			}

			activatePlayableSource(store, file, url, resumeTime, shouldAutoplay)
			return true
		},

		setNotice(message) {
			store.notice = message
		},

		async setTorrentInfo(infoHash) {
			const requestId = store.metadataRequestId + 1
			store.metadataRequestId = requestId
			if (!(await prepareTorrentSwitch(store, infoHash, requestId))) {
				return false
			}

			const info = await requestTorrentInfo(store, infoHash, requestId)
			if (!info) {
				return false
			}

			const torrentInfo = normalizeTorrentInfo(info)
			runInAction(() => {
				store.torrentInfo = torrentInfo
			})
			await resumeSavedFile(store, torrentInfo, infoHash, requestId)
			return true
		},
		sourceRequestId: 0,
		torrentInfo: emptyTorrentInfo(),

		updateCached({ path }, cached) {
			const file = store.torrentInfo.files.find(({ path: candidatePath }) =>
				comparePath(path, candidatePath)
			)
			if (file) {
				file.cached = cached
				file.state = 'ready'
				store.filesVersion += 1
			}
		},
	}))

	React.useEffect(() => {
		store.playerStore.setLifecycleHandlers({
			onEnd: store.handlePlaybackEnd,
			onError: store.handlePlaybackError,
			onPause: () => store.saveCurrentPlaying({ force: true }),
		})
		return () => {
			store.playerStore.setLifecycleHandlers()
		}
	}, [store])

	React.useEffect(() => {
		const interval = setInterval(() => {
			store.saveCurrentPlaying().catch(ignoreFailure)
		}, RESUME_SAVE_INTERVAL_MS)
		return () => clearInterval(interval)
	}, [store])

	React.useEffect(() => {
		const handleVisibilityChange = () => {
			if (document.visibilityState === 'hidden') {
				store.saveCurrentPlaying({ force: true }).catch(ignoreFailure)
			}
		}
		document.addEventListener('visibilitychange', handleVisibilityChange)
		return () => {
			document.removeEventListener('visibilitychange', handleVisibilityChange)
		}
	}, [store])

	return store
}
