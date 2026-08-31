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
import {
	cacheFileForOffline,
	cancelOfflineDownloads,
	getPlayableSource,
	getServerCachedBytes,
	getStoredTorrentInfo,
	getTorrentInfo,
} from './api'
import { OfflineCacheError } from './offlineCache'
import {
	publishOfflineChange,
	subscribeToOfflineChanges,
} from './offlineEvents'
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

const isAbortError = (error) =>
	error instanceof DOMException && error.name === 'AbortError'

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
		length:
			originalFile?.length ?? storedFile.length ?? storedFile.file?.size ?? 0,
		mimeType:
			originalFile?.mimeType ??
			storedFile.mimeType ??
			storedFile.file?.type ??
			'',
		name: originalFile?.name ?? pathParts.at(-1) ?? storedPath,
		offlineDownloadedBytes:
			originalFile?.length ?? storedFile.length ?? storedFile.file?.size ?? 0,
		offlineState: 'available',
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
	length: storedFile.length ?? storedFile.file?.size ?? 0,
	mimeType: storedFile.mimeType || storedFile.file?.type || 'audio/mpeg',
	name: pathParts.at(-1) ?? storedPath,
	offlineDownloadedBytes: storedFile.length ?? storedFile.file?.size ?? 0,
	offlineState: 'available',
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

const persistedOfflineStateLabel = (state) => {
	if (state?.complete) {
		return 'available'
	}
	return state ? 'paused' : undefined
}

const isCurrentSourceRequest = (store, requestId) =>
	requestId === store.sourceRequestId && !store.disposed

const playbackEndWasSuperseded = (store, requestId) =>
	!isCurrentSourceRequest(store, requestId) ||
	store.playerStore.playWhenReady ||
	store.playerStore.playing

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
	if (!file.cached) {
		store.cacheOfflineFile(file).catch(ignoreFailure)
	}
	return true
}

const reuseAuthorizedCurrentSource = (
	store,
	file,
	state,
	options,
	resumeTime
) => {
	if (!store.serverAccessAllowed && store.currentSourceKind === 'server') {
		return false
	}
	return reuseCurrentSource(store, file, state, options, resumeTime)
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

const resolvePlayableSource = async (store, file, requestId, allowServer) => {
	try {
		const source = await getPlayableSource(store.ih, file, { allowServer })
		if (!isCurrentSourceRequest(store, requestId)) {
			releaseUrl(source.url)
			return null
		}
		return source
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
	source,
	resumeTime,
	shouldAutoplay
) => {
	runInAction(() => {
		store.currentSourceKind = source.kind
		file.state = 'ready'
		store.currentFile = file
	})
	store.playerStore.loadSource({
		autoplay: shouldAutoplay,
		format: getAudioFormat(file),
		resumeTime,
		url: source.url,
	})
}

const cacheServerSourceOffline = (store, file, source) => {
	if (source.kind === 'server') {
		store.cacheOfflineFile(file).catch(ignoreFailure)
	}
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
		store.currentSourceKind = null
		store.ih = infoHash
		store.serverCachedBytes = null
		store.torrentInfo = emptyTorrentInfo()
	})
	return true
}

const requestTorrentInfo = async (store, infoHash, requestId, cacheOnly) => {
	try {
		const info = cacheOnly
			? await getStoredTorrentInfo(infoHash)
			: await getTorrentInfo(infoHash)
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

const hasCurrentOfflineTarget = (store, infoHash, file) =>
	infoHash === store.ih &&
	!store.disposed &&
	store.torrentInfo.files.some(({ path }) => comparePath(path, file.path))

const reconcileOfflineChange = async (store, change) => {
	if (change.infoHash !== store.ih.toLowerCase()) {
		return
	}
	if (change.kind === 'removed') {
		await cancelOfflineDownloads(store.ih)
	}
	await store.refreshOfflineState(change.path)
}

const isBulkDownloadCurrent = async (
	store,
	infoHash,
	requestId,
	expectedGeneration
) => {
	if (store.bulkDownloadRequestId !== requestId || store.disposed) {
		return false
	}
	try {
		return (await storage.getOfflineGeneration(infoHash)) === expectedGeneration
	} catch {
		return false
	}
}

const downloadFileInBulk = async (store, file, expectedGeneration) => {
	runInAction(() => {
		file.state = 'loading'
	})
	const saved = await store.cacheOfflineFile(file, {
		expectedGeneration,
		showFailure: false,
	})
	runInAction(() => {
		file.state = 'ready'
	})
	return saved
}

const downloadFilesInBulk = async (
	store,
	files,
	infoHash,
	requestId,
	expectedGeneration
) => {
	let failedCount = 0
	for (const file of files) {
		// biome-ignore lint/performance/noAwaitInLoops: Bulk saves are intentionally sequential to bound memory, network, and IndexedDB pressure.
		const currentBeforeDownload = await isBulkDownloadCurrent(
			store,
			infoHash,
			requestId,
			expectedGeneration
		)
		if (!currentBeforeDownload) {
			return null
		}
		const saved = await downloadFileInBulk(store, file, expectedGeneration)
		if (!saved) {
			failedCount += 1
		}
		const currentAfterDownload = await isBulkDownloadCurrent(
			store,
			infoHash,
			requestId,
			expectedGeneration
		)
		if (!currentAfterDownload) {
			return null
		}
	}
	return failedCount
}

const applyOfflineFailure = (store, infoHash, file, error, showFailure) => {
	if (!hasCurrentOfflineTarget(store, infoHash, file)) {
		return
	}
	const target = store.torrentInfo.files.find(({ path }) =>
		comparePath(path, file.path)
	)
	if (target) {
		target.offlineState =
			error instanceof OfflineCacheError && error.code === 'quota_exceeded'
				? 'unavailable'
				: 'failed'
		if (file !== target) {
			file.offlineState = target.offlineState
		}
	}
	if (!showFailure) {
		return
	}
	const message =
		error instanceof Error
			? error.message
			: 'Unable to save this audiobook offline.'
	store.setNotice(`${message} Streaming is still available.`)
}

const handleOfflineCacheError = async ({
	error,
	file,
	requestedInfoHash,
	showFailure,
	store,
}) => {
	if (isAbortError(error)) {
		const state = await storage.getOfflineFileState(
			requestedInfoHash,
			pathKey(file.path)
		)
		if (hasCurrentOfflineTarget(store, requestedInfoHash, file)) {
			runInAction(() => {
				store.applyPersistedOfflineState(file, state)
			})
		}
		return false
	}
	runInAction(() => {
		applyOfflineFailure(store, requestedInfoHash, file, error, showFailure)
	})
	return false
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
		applyOfflineProgress(file, progress) {
			const target = store.torrentInfo.files.find(({ path }) =>
				comparePath(path, file.path)
			)
			if (!target) {
				return
			}
			const becameAvailable = progress.state === 'complete' && !target.cached
			target.cached = progress.state === 'complete'
			target.offlineDownloadedBytes = progress.downloadedBytes
			target.offlineState =
				progress.state === 'complete' ? 'available' : 'saving'
			if (file !== target) {
				file.cached = target.cached
				file.offlineDownloadedBytes = target.offlineDownloadedBytes
				file.offlineState = target.offlineState
			}
			if (becameAvailable) {
				store.filesVersion += 1
			}
		},
		applyPersistedOfflineState(file, state) {
			const target = store.torrentInfo.files.find(({ path }) =>
				comparePath(path, file.path)
			)
			if (!target) {
				return
			}
			const wasCached = Boolean(target.cached)
			target.cached = Boolean(state?.complete)
			target.offlineDownloadedBytes = state?.downloadedBytes ?? 0
			target.offlineState = persistedOfflineStateLabel(state)
			if (file !== target) {
				file.cached = target.cached
				file.offlineDownloadedBytes = target.offlineDownloadedBytes
				file.offlineState = target.offlineState
			}
			if (wasCached !== target.cached) {
				store.filesVersion += 1
			}
		},

		bulkDownloadRequestId: 0,

		async cacheOfflineFile(
			file,
			{ expectedGeneration, showFailure = true } = {}
		) {
			if (!store.serverAccessAllowed) {
				if (showFailure) {
					store.setNotice(
						'Authorize this server download before saving more files offline.'
					)
				}
				return false
			}
			const requestedInfoHash = store.ih
			try {
				await cacheFileForOffline(
					requestedInfoHash,
					file,
					(progress) => {
						if (!hasCurrentOfflineTarget(store, requestedInfoHash, file)) {
							return
						}
						runInAction(() => {
							store.applyOfflineProgress(file, progress)
						})
					},
					{ expectedGeneration }
				)
				if (
					requestedInfoHash === store.ih &&
					!store.disposed &&
					comparePath(file.path, store.currentFile.path)
				) {
					await store.switchCurrentSourceToOffline()
				}
				return true
			} catch (error) {
				return await handleOfflineCacheError({
					error,
					file,
					requestedInfoHash,
					showFailure,
					store,
				})
			}
		},
		async cleanBookData(infoHash) {
			store.bulkDownloadRequestId += 1
			const snapshot = store.createResumeSnapshot()
			store.sourceRequestId += 1
			store.playerStore.clearSource()
			store.currentFile = emptyCurrentFile()
			store.currentSourceKind = null
			await store.persistResumeSnapshot(snapshot)
			await cancelOfflineDownloads(infoHash)
			const result = await storage.removeFilesByIh(infoHash)
			if (result) {
				publishOfflineChange({ infoHash, kind: 'removed' })
				store.filesVersion += 1
				await store.setTorrentInfo(infoHash, {
					cacheOnly: !store.serverAccessAllowed,
					resumePlayback: false,
				})
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
		currentSourceKind: null,

		async dispose() {
			if (store.disposed) {
				return
			}
			store.disposed = true
			store.bulkDownloadRequestId += 1
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
			if (!store.serverAccessAllowed) {
				store.setNotice(
					'Authorize this server download before saving more files offline.'
				)
				return false
			}

			const filesToDownload = torrentInfo.files.filter((file) => !file.cached)
			if (filesToDownload.length === 0) {
				return true
			}

			const requestId = store.bulkDownloadRequestId + 1
			store.bulkDownloadRequestId = requestId
			const expectedGeneration = await storage.getOfflineGeneration(infoHash)
			const failedCount = await downloadFilesInBulk(
				store,
				filesToDownload,
				infoHash,
				requestId,
				expectedGeneration
			)
			if (failedCount === null) {
				return false
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
			if (playbackEndWasSuperseded(store, requestId)) {
				return
			}
			const nextFile = await store.getNextFile()
			if (playbackEndWasSuperseded(store, requestId)) {
				return
			}
			if (!nextFile) {
				store.playerStore.finishPlayback()
				if (store.currentSourceKind === 'server' && store.currentFile.cached) {
					await store.switchCurrentSourceToOffline({ resumeTime: 0 })
				} else if (
					store.currentSourceKind === 'offline' &&
					!store.currentFile.cached
				) {
					await store.switchCurrentSourceToServer({ resumeTime: 0 })
				}
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

		async handlePlaybackLoad() {
			if (
				store.currentSourceKind === 'server' &&
				store.currentFile.cached &&
				!store.playerStore.playWhenReady &&
				!store.playerStore.playing
			) {
				await store.switchCurrentSourceToOffline()
				return
			}
			if (
				store.currentSourceKind === 'offline' &&
				!store.currentFile.cached &&
				!store.playerStore.playWhenReady &&
				!store.playerStore.playing
			) {
				await store.switchCurrentSourceToServer()
			}
		},

		async handlePlaybackPause() {
			await store.saveCurrentPlaying({ force: true })
			if (
				store.currentSourceKind === 'server' &&
				store.currentFile.cached &&
				!store.playerStore.playing
			) {
				await store.switchCurrentSourceToOffline()
				return
			}
			if (
				store.currentSourceKind === 'offline' &&
				!store.currentFile.cached &&
				!store.playerStore.playing
			) {
				await store.switchCurrentSourceToServer()
			}
		},

		handlePlaybackPlay() {
			if (
				store.currentSourceKind === 'server' &&
				store.currentFile.path.length > 0 &&
				!store.currentFile.cached &&
				store.currentFile.offlineState !== 'saving'
			) {
				store.cacheOfflineFile(store.currentFile).catch(ignoreFailure)
			}
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

		async refreshOfflineState(changedPath) {
			const requestedInfoHash = store.ih
			const states =
				await storage.getOfflineFileStatesForTorrent(requestedInfoHash)
			if (requestedInfoHash !== store.ih || store.disposed) {
				return
			}
			const statesByPath = new Map(states.map((state) => [state.path, state]))
			runInAction(() => {
				for (const file of store.torrentInfo.files) {
					const filePath = pathKey(file.path)
					if (changedPath === undefined || changedPath === filePath) {
						store.applyPersistedOfflineState(
							file,
							statesByPath.get(filePath) ?? null
						)
					}
				}
				const currentPath = pathKey(store.currentFile.path)
				if (
					currentPath &&
					(changedPath === undefined || changedPath === currentPath)
				) {
					store.applyPersistedOfflineState(
						store.currentFile,
						statesByPath.get(currentPath) ?? null
					)
				}
			})
			if (store.currentFile.cached) {
				await store.switchCurrentSourceToOffline()
				return
			}
			await store.switchCurrentSourceToServer()
		},

		async refreshServerCache() {
			const requestedInfoHash = store.ih
			const cachedBytes = await getServerCachedBytes(requestedInfoHash)
			if (requestedInfoHash !== store.ih || store.disposed) {
				return
			}
			runInAction(() => {
				store.serverCachedBytes = cachedBytes
			})
		},

		async removeBook(infoHash) {
			store.bulkDownloadRequestId += 1
			store.metadataRequestId += 1
			store.sourceRequestId += 1
			store.playerStore.clearSource()
			store.currentFile = emptyCurrentFile()
			store.currentSourceKind = null
			await cancelOfflineDownloads(infoHash)
			const removed = await storage.removeFilesAndTorrent(infoHash)
			if (removed) {
				publishOfflineChange({ infoHash, kind: 'removed' })
			}
			return removed
		},

		async removeFile(infoHash, file) {
			store.bulkDownloadRequestId += 1
			await cancelOfflineDownloads(infoHash, file.path)
			if (comparePath(file.path, store.currentFile.path)) {
				await store.saveCurrentPlaying({ force: true })
				store.sourceRequestId += 1
				store.playerStore.clearSource()
				store.currentFile = emptyCurrentFile()
				store.currentSourceKind = null
			}
			const success = await storage.removeFile(infoHash, pathKey(file.path))
			if (success) {
				publishOfflineChange({
					infoHash,
					kind: 'removed',
					path: pathKey(file.path),
				})
				runInAction(() => {
					file.cached = false
					file.offlineDownloadedBytes = 0
					file.offlineState = undefined
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
		serverAccessAllowed: false,
		serverCachedBytes: null,

		async setCurrentFile(file, state, options = {}) {
			if (!(file && isAudioFile(file))) {
				store.setNotice('This file is not a supported audio format.')
				return false
			}

			const resumeTime = playbackTime(state?.time)
			if (
				reuseAuthorizedCurrentSource(store, file, state, options, resumeTime)
			) {
				if (
					file.cached &&
					store.currentSourceKind === 'server' &&
					!store.playerStore.playing
				) {
					await store.switchCurrentSourceToOffline()
				}
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
			const source = await resolvePlayableSource(
				store,
				file,
				requestId,
				store.serverAccessAllowed
			)
			if (!source) {
				return false
			}

			activatePlayableSource(store, file, source, resumeTime, shouldAutoplay)
			cacheServerSourceOffline(store, file, source)
			return true
		},

		setNotice(message) {
			store.notice = message
		},

		setServerAccessAllowed(allowed) {
			store.serverAccessAllowed = Boolean(allowed)
		},

		async setTorrentInfo(
			infoHash,
			{ cacheOnly = false, resumePlayback = true } = {}
		) {
			if (!(cacheOnly || store.serverAccessAllowed)) {
				store.setNotice(
					'Authorize this server download before loading book details.'
				)
				return false
			}
			const requestId = store.metadataRequestId + 1
			store.metadataRequestId = requestId
			if (!(await prepareTorrentSwitch(store, infoHash, requestId))) {
				return false
			}

			const info = await requestTorrentInfo(
				store,
				infoHash,
				requestId,
				cacheOnly
			)
			if (!info) {
				return false
			}

			const torrentInfo = normalizeTorrentInfo(info)
			runInAction(() => {
				store.torrentInfo = torrentInfo
			})
			if (!cacheOnly || store.serverAccessAllowed) {
				await store.refreshServerCache()
			}
			if (!isCurrentMetadataRequest(store, requestId)) {
				return false
			}
			if (resumePlayback) {
				await resumeSavedFile(store, torrentInfo, infoHash, requestId)
			}
			return true
		},
		sourceRequestId: 0,

		async switchCurrentSourceToOffline({
			resumeTime: requestedResumeTime,
		} = {}) {
			if (
				store.currentSourceKind !== 'server' ||
				store.playerStore.loading ||
				store.playerStore.playWhenReady ||
				store.playerStore.playing ||
				!store.currentFile.cached
			) {
				return false
			}
			const requestId = store.sourceRequestId
			const file = store.currentFile
			const source = await getPlayableSource(store.ih, file)
			if (
				!isCurrentSourceRequest(store, requestId) ||
				store.playerStore.loading ||
				store.playerStore.playWhenReady ||
				store.playerStore.playing ||
				!comparePath(file.path, store.currentFile.path) ||
				store.currentSourceKind !== 'server' ||
				!store.currentFile.cached ||
				source.kind !== 'offline'
			) {
				releaseUrl(source.url)
				return false
			}
			runInAction(() => {
				store.currentSourceKind = 'offline'
			})
			const resumeTime = requestedResumeTime ?? store.playerStore.getProgress()
			store.playerStore.loadSource({
				format: getAudioFormat(file),
				resumeTime,
				url: source.url,
			})
			return true
		},

		async switchCurrentSourceToServer({
			resumeTime: requestedResumeTime,
		} = {}) {
			if (
				!store.serverAccessAllowed ||
				store.currentSourceKind !== 'offline' ||
				store.playerStore.loading ||
				store.playerStore.playWhenReady ||
				store.playerStore.playing ||
				store.currentFile.cached
			) {
				return false
			}
			const requestId = store.sourceRequestId
			const file = store.currentFile
			const source = await getPlayableSource(store.ih, file)
			if (
				!isCurrentSourceRequest(store, requestId) ||
				store.playerStore.loading ||
				store.playerStore.playWhenReady ||
				store.playerStore.playing ||
				!comparePath(file.path, store.currentFile.path) ||
				store.currentSourceKind !== 'offline' ||
				store.currentFile.cached ||
				source.kind !== 'server'
			) {
				releaseUrl(source.url)
				return false
			}
			runInAction(() => {
				store.currentSourceKind = 'server'
			})
			const resumeTime = requestedResumeTime ?? store.playerStore.getProgress()
			store.playerStore.loadSource({
				format: getAudioFormat(file),
				resumeTime,
				url: source.url,
			})
			return true
		},
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
			onLoad: store.handlePlaybackLoad,
			onPause: store.handlePlaybackPause,
			onPlay: store.handlePlaybackPlay,
		})
		return () => {
			store.playerStore.setLifecycleHandlers()
		}
	}, [store])

	React.useEffect(
		() =>
			subscribeToOfflineChanges((change) => {
				reconcileOfflineChange(store, change).catch(store.handlePlaybackError)
			}),
		[store]
	)

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
