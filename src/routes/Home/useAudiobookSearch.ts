import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'wouter'
import { registerTorrent } from '~/routes/Playlist/api'
import {
	getSearchProviders,
	resolveAudiobookResult,
	searchAudiobooks,
} from '~/search/api'
import {
	enabledTrackerProviderIds,
	loadSearchPreferences,
	saveSearchPreferences,
} from '~/search/preferences'
import type {
	AudiobookSearchResult,
	SearchProviderReport,
} from '~/search/types'

const BASE32_INFO_HASH_PATTERN = /^[a-z2-7]{32}$/i
const HEX_INFO_HASH_PATTERN = /^[a-f\d]{40}$/i
const MAGNET_PATTERN = /^magnet:/i

export type AudiobookSearchStatus = 'error' | 'idle' | 'searching' | 'success'

export interface ContentUseConfirmation {
	action: 'open-direct' | 'open-tracker'
	sourceLabel?: string
}

type PendingContentUse =
	| { kind: 'direct'; source: string }
	| { kind: 'tracker'; result: AudiobookSearchResult }

export interface AudiobookSearchController {
	activeQuery: string | null
	cancelContentUseConfirmation: () => void
	clearSearch: () => void
	confirmContentUseConfirmation: () => Promise<void>
	contentUseConfirmation: ContentUseConfirmation | null
	error: string | null
	hasSearched: boolean
	isOpeningDirect: boolean
	openingResultKey: string | null
	openResult: (result: AudiobookSearchResult) => Promise<void>
	providerReports: SearchProviderReport[]
	query: string
	reportError: (message: string) => void
	results: AudiobookSearchResult[]
	setQuery: (query: string) => void
	status: AudiobookSearchStatus
	submit: () => Promise<void>
	trackerProviderIds: string[]
}

export const searchResultKey = (
	result: Pick<AudiobookSearchResult, 'id' | 'providerId'>
): string => `${result.providerId}:${result.id}`

const isTorrentReference = (value: string): boolean =>
	MAGNET_PATTERN.test(value) ||
	HEX_INFO_HASH_PATTERN.test(value) ||
	BASE32_INFO_HASH_PATTERN.test(value)

const errorMessage = (value: unknown, fallback: string): string =>
	value instanceof Error ? value.message : fallback

const isAbortError = (value: unknown): boolean =>
	value instanceof Error && value.name === 'AbortError'

const loadEnabledTrackerProviderIds = async (
	signal: AbortSignal
): Promise<string[]> => {
	const catalog = await getSearchProviders(signal)
	const preferences = loadSearchPreferences()
	const providerIds = enabledTrackerProviderIds(preferences, catalog.providers)
	if (providerIds.length !== preferences.enabledOptionalProviderIds.length) {
		saveSearchPreferences({
			...preferences,
			enabledOptionalProviderIds: providerIds,
		})
	}
	return providerIds
}

export const useAudiobookSearch = (): AudiobookSearchController => {
	const [, setLocation] = useLocation()
	const [activeQuery, setActiveQuery] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [isOpeningDirect, setIsOpeningDirect] = useState(false)
	const [openingResultKey, setOpeningResultKey] = useState<string | null>(null)
	const [pendingContentUse, setPendingContentUse] =
		useState<PendingContentUse | null>(null)
	const [providerReports, setProviderReports] = useState<
		SearchProviderReport[]
	>([])
	const [query, setQueryState] = useState('')
	const [results, setResults] = useState<AudiobookSearchResult[]>([])
	const [status, setStatus] = useState<AudiobookSearchStatus>('idle')
	const [trackerProviderIds, setTrackerProviderIds] = useState<string[]>([])
	const directRequestId = useRef(0)
	const confirmationInFlight = useRef(false)
	const resolveController = useRef<AbortController | null>(null)
	const resolveRequestId = useRef(0)
	const searchController = useRef<AbortController | null>(null)
	const searchRequestId = useRef(0)

	useEffect(
		() => () => {
			directRequestId.current += 1
			resolveRequestId.current += 1
			searchRequestId.current += 1
			searchController.current?.abort()
			resolveController.current?.abort()
		},
		[]
	)

	const setQuery = useCallback((nextQuery: string): void => {
		setQueryState(nextQuery)
		setError(null)
	}, [])

	const reportError = useCallback((message: string): void => {
		setError(message)
	}, [])

	const clearSearch = useCallback((): void => {
		searchController.current?.abort()
		resolveController.current?.abort()
		searchRequestId.current += 1
		resolveRequestId.current += 1
		setActiveQuery(null)
		setError(null)
		setOpeningResultKey(null)
		setPendingContentUse(null)
		setProviderReports([])
		setQueryState('')
		setResults([])
		setStatus('idle')
		setTrackerProviderIds([])
	}, [])

	const openDirectTorrent = useCallback(
		async (source: string): Promise<void> => {
			const requestId = directRequestId.current + 1
			directRequestId.current = requestId
			searchController.current?.abort()
			searchRequestId.current += 1
			setActiveQuery(null)
			setError(null)
			setIsOpeningDirect(true)
			setProviderReports([])
			setResults([])
			setStatus('idle')
			try {
				const registration = await registerTorrent(source)
				if (requestId !== directRequestId.current) {
					return
				}
				setLocation(`/playlist/${registration.infoHash}`)
			} catch (value) {
				if (requestId === directRequestId.current) {
					setError(errorMessage(value, 'Unable to register this torrent'))
				}
			} finally {
				if (requestId === directRequestId.current) {
					setIsOpeningDirect(false)
				}
			}
		},
		[setLocation]
	)

	const submit = useCallback(async (): Promise<void> => {
		const source = query.trim()
		if (!source) {
			setError('Enter an audiobook title, magnet link, or info hash')
			return
		}
		if (isOpeningDirect || openingResultKey || pendingContentUse) {
			return
		}
		if (isTorrentReference(source)) {
			setError(null)
			setPendingContentUse({ kind: 'direct', source })
			return
		}

		resolveController.current?.abort()
		resolveRequestId.current += 1
		searchController.current?.abort()
		const controller = new AbortController()
		searchController.current = controller
		const requestId = searchRequestId.current + 1
		searchRequestId.current = requestId

		setActiveQuery(source)
		setError(null)
		setOpeningResultKey(null)
		setProviderReports([])
		setResults([])
		setStatus('searching')
		setTrackerProviderIds([])

		try {
			const optionalProviderIds = await loadEnabledTrackerProviderIds(
				controller.signal
			)
			if (controller.signal.aborted || requestId !== searchRequestId.current) {
				return
			}
			setTrackerProviderIds(optionalProviderIds)
			const response = await searchAudiobooks(
				source,
				optionalProviderIds,
				controller.signal
			)
			if (controller.signal.aborted || requestId !== searchRequestId.current) {
				return
			}
			setActiveQuery(response.query)
			setProviderReports(response.providers)
			setResults(response.results)
			setStatus('success')
		} catch (value) {
			if (
				isAbortError(value) ||
				controller.signal.aborted ||
				requestId !== searchRequestId.current
			) {
				return
			}
			setError(errorMessage(value, 'Unable to search for audiobooks'))
			setStatus('error')
		}
	}, [isOpeningDirect, openingResultKey, pendingContentUse, query])

	const resolveResult = useCallback(
		async (result: AudiobookSearchResult): Promise<void> => {
			resolveController.current?.abort()
			const controller = new AbortController()
			resolveController.current = controller
			const requestId = resolveRequestId.current + 1
			resolveRequestId.current = requestId
			const resultKey = searchResultKey(result)
			setError(null)
			setOpeningResultKey(resultKey)
			try {
				const registration = await resolveAudiobookResult(
					result.providerId,
					result.id,
					controller.signal
				)
				if (
					controller.signal.aborted ||
					requestId !== resolveRequestId.current
				) {
					return
				}
				setLocation(`/playlist/${registration.infoHash}`)
			} catch (value) {
				if (
					isAbortError(value) ||
					controller.signal.aborted ||
					requestId !== resolveRequestId.current
				) {
					return
				}
				setError(errorMessage(value, 'Unable to open this audiobook'))
			} finally {
				if (requestId === resolveRequestId.current) {
					setOpeningResultKey(null)
				}
			}
		},
		[setLocation]
	)

	const openResult = useCallback(
		async (result: AudiobookSearchResult): Promise<void> => {
			if (isOpeningDirect || openingResultKey || pendingContentUse) {
				return
			}
			if (trackerProviderIds.includes(result.providerId)) {
				setError(null)
				setPendingContentUse({ kind: 'tracker', result: { ...result } })
				return
			}
			await resolveResult(result)
		},
		[
			isOpeningDirect,
			openingResultKey,
			pendingContentUse,
			resolveResult,
			trackerProviderIds,
		]
	)

	const cancelContentUseConfirmation = useCallback((): void => {
		setPendingContentUse(null)
	}, [])

	const confirmContentUseConfirmation = useCallback(async (): Promise<void> => {
		if (!(pendingContentUse && !confirmationInFlight.current)) {
			return
		}
		const confirmedAction = pendingContentUse
		confirmationInFlight.current = true
		setPendingContentUse(null)
		try {
			if (confirmedAction.kind === 'direct') {
				await openDirectTorrent(confirmedAction.source)
			} else {
				await resolveResult(confirmedAction.result)
			}
		} finally {
			confirmationInFlight.current = false
		}
	}, [openDirectTorrent, pendingContentUse, resolveResult])

	const contentUseConfirmation: ContentUseConfirmation | null =
		pendingContentUse
			? {
					action:
						pendingContentUse.kind === 'direct'
							? 'open-direct'
							: 'open-tracker',
					...(pendingContentUse.kind === 'tracker'
						? { sourceLabel: pendingContentUse.result.title }
						: {}),
				}
			: null

	return {
		activeQuery,
		cancelContentUseConfirmation,
		clearSearch,
		confirmContentUseConfirmation,
		contentUseConfirmation,
		error,
		hasSearched: activeQuery !== null,
		isOpeningDirect,
		openingResultKey,
		openResult,
		providerReports,
		query,
		reportError,
		results,
		setQuery,
		status,
		submit,
		trackerProviderIds,
	}
}
