import { ArrowLeft, Check, CircleAlert, ExternalLink } from 'lucide-react'
import {
	type ChangeEvent,
	useCallback,
	useEffect,
	useId,
	useState,
} from 'react'
import { Link } from 'wouter'
import { captionApi, type TranscriptionSettings } from '~/captions/api'
import { boundedSettingsRequest } from '~/captions/settingsRequests'
import { ContentUseDialog } from '~/components/ContentUseDialog'
import { ContentUseNotice } from '~/components/ContentUseNotice'
import { Nav } from '~/components/layout/Nav'
import {
	PageContent,
	PageShell,
	SectionHeading,
} from '~/components/layout/Page'
import { ThemeToggle } from '~/components/theme-toggle'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card } from '~/components/ui/card'
import { Checkbox } from '~/components/ui/checkbox'
import { getSearchProviders } from '~/search/api'
import { CONTENT_USE_POLICY_VERSION } from '~/search/contentPolicy'
import {
	enabledTrackerProviderIds,
	hasCurrentContentPolicyAcknowledgement,
	loadSearchPreferences,
	type SearchPreferences,
	saveSearchPreferences,
} from '~/search/preferences'
import type { SearchProviderDescriptor } from '~/search/types'
import { safeExternalUrl } from '~/search/url'

interface ProviderHomepageProps {
	homepage: string
	label: string
}

interface TrackerProviderRowProps {
	enabled: boolean
	onChange: (providerId: string, enabled: boolean) => void
	provider: SearchProviderDescriptor
}

const TRANSCRIPTION_CLEANUP_POLL_INTERVAL_MS = 1500

const ProviderHomepage = ({ homepage, label }: ProviderHomepageProps) => {
	const url = safeExternalUrl(homepage)
	if (!url) {
		return null
	}
	return (
		<a
			className='inline-flex items-center gap-1 text-muted-foreground text-xs underline underline-offset-4 hover:text-foreground'
			href={url}
			rel='noopener noreferrer'
			target='_blank'
		>
			Visit {label}
			<ExternalLink aria-hidden='true' className='h-3 w-3' />
		</a>
	)
}

const supportedSavedProviderIds = (
	providers: readonly SearchProviderDescriptor[]
): SearchPreferences => {
	const preferences = loadSearchPreferences()
	const providerIds = enabledTrackerProviderIds(preferences, providers)
	const normalizedPreferences = {
		...preferences,
		enabledOptionalProviderIds: providerIds,
	}
	if (
		JSON.stringify(providerIds) !==
		JSON.stringify(preferences.enabledOptionalProviderIds)
	) {
		saveSearchPreferences(normalizedPreferences)
	}
	return normalizedPreferences
}

const freeProviderDescription = (
	provider: SearchProviderDescriptor
): string => {
	if (provider.rights === 'public-domain-source') {
		return 'This source describes its recordings as public domain in the United States. Verify their status where you live.'
	}
	return 'Results have rights information supplied by the source. TPlayer does not guarantee that label; review each item before opening it.'
}

const TrackerProviderRow = ({
	enabled,
	onChange,
	provider,
}: TrackerProviderRowProps) => {
	const inputId = useId()
	const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
		onChange(provider.id, event.currentTarget.checked)
	}
	return (
		<li>
			<Card className='p-4'>
				<div className='flex items-start gap-3'>
					<Checkbox
						checked={enabled}
						className='mt-1'
						id={inputId}
						onChange={handleChange}
					/>
					<div className='min-w-0 flex-1'>
						<label className='cursor-pointer font-medium' htmlFor={inputId}>
							{provider.label}
						</label>
						<p className='mt-1 text-muted-foreground text-sm'>
							This independent tracker is off by default. TPlayer does not
							verify or endorse its listings or their rights status.
						</p>
						<div className='mt-2'>
							<ProviderHomepage
								homepage={provider.homepage}
								label={provider.label}
							/>
						</div>
					</div>
				</div>
			</Card>
		</li>
	)
}

const Settings = () => {
	const automaticTranscriptionId = useId()
	const [error, setError] = useState<string | null>(null)
	const [isLoading, setIsLoading] = useState(true)
	const [pendingProviderId, setPendingProviderId] = useState<string | null>(
		null
	)
	const [preferences, setPreferences] = useState<SearchPreferences>(() =>
		loadSearchPreferences()
	)
	const [providers, setProviders] = useState<SearchProviderDescriptor[]>([])
	const [saveMessage, setSaveMessage] = useState<string | null>(null)
	const [transcriptionError, setTranscriptionError] = useState<string | null>(
		null
	)
	const [transcriptionSettings, setTranscriptionSettings] =
		useState<TranscriptionSettings | null>(null)
	const [transcriptionSettingsLoading, setTranscriptionSettingsLoading] =
		useState(true)
	const [transcriptionSettingsSaving, setTranscriptionSettingsSaving] =
		useState(false)

	useEffect(() => {
		const controller = new AbortController()
		let retryTimer: ReturnType<typeof setTimeout> | null = null
		const loadSettings = async (): Promise<void> => {
			try {
				const settings = await boundedSettingsRequest(
					captionApi,
					'read',
					(signal) => captionApi.getSettings(signal),
					{ signal: controller.signal }
				)
				if (!controller.signal.aborted) {
					setTranscriptionSettings(settings)
					setTranscriptionError(null)
				}
			} catch (value) {
				if (!controller.signal.aborted) {
					setTranscriptionError(
						value instanceof Error
							? value.message
							: 'Unable to load transcription settings'
					)
					retryTimer = setTimeout(
						loadSettings,
						TRANSCRIPTION_CLEANUP_POLL_INTERVAL_MS
					)
				}
			} finally {
				if (!controller.signal.aborted) {
					setTranscriptionSettingsLoading(false)
				}
			}
		}
		loadSettings()
		return () => {
			controller.abort()
			if (retryTimer !== null) {
				clearTimeout(retryTimer)
			}
		}
	}, [])

	useEffect(() => {
		if (!transcriptionSettings?.cleanupPending) {
			return
		}
		const controller = new AbortController()
		let timer: ReturnType<typeof setTimeout> | null = null
		const pollSettings = async (): Promise<void> => {
			try {
				const settings = await boundedSettingsRequest(
					captionApi,
					'read',
					(signal) => captionApi.getSettings(signal),
					{ signal: controller.signal }
				)
				if (controller.signal.aborted) {
					return
				}
				setTranscriptionSettings(settings)
				setTranscriptionError(null)
				if (settings.cleanupPending) {
					timer = setTimeout(
						pollSettings,
						TRANSCRIPTION_CLEANUP_POLL_INTERVAL_MS
					)
				}
			} catch (value) {
				if (!controller.signal.aborted) {
					setTranscriptionError(
						value instanceof Error
							? value.message
							: 'Unable to confirm transcription cleanup'
					)
					timer = setTimeout(
						pollSettings,
						TRANSCRIPTION_CLEANUP_POLL_INTERVAL_MS
					)
				}
			}
		}
		timer = setTimeout(pollSettings, TRANSCRIPTION_CLEANUP_POLL_INTERVAL_MS)
		return () => {
			controller.abort()
			if (timer !== null) {
				clearTimeout(timer)
			}
		}
	}, [transcriptionSettings?.cleanupPending])

	useEffect(() => {
		const controller = new AbortController()
		const loadProviders = async (): Promise<void> => {
			try {
				const catalog = await getSearchProviders(controller.signal)
				if (!controller.signal.aborted) {
					setProviders(catalog.providers)
					setPreferences(supportedSavedProviderIds(catalog.providers))
					setError(null)
				}
			} catch (value) {
				if (!controller.signal.aborted) {
					setError(
						value instanceof Error
							? value.message
							: 'Unable to load search sources'
					)
				}
			} finally {
				if (!controller.signal.aborted) {
					setIsLoading(false)
				}
			}
		}
		loadProviders()
		return () => {
			controller.abort()
		}
	}, [])

	const handleProviderChange = useCallback(
		(providerId: string, enabled: boolean): void => {
			if (enabled) {
				if (hasCurrentContentPolicyAcknowledgement(preferences)) {
					const nextPreferences = {
						...preferences,
						enabledOptionalProviderIds: [
							...new Set([
								...preferences.enabledOptionalProviderIds,
								providerId,
							]),
						].sort(),
					}
					if (!saveSearchPreferences(nextPreferences)) {
						setSaveMessage(null)
						setError('Unable to save search settings in this browser')
						return
					}
					setPreferences(nextPreferences)
					setError(null)
					setSaveMessage('Search settings saved')
					return
				}
				setPendingProviderId(providerId)
				return
			}
			const nextPreferences = {
				...preferences,
				enabledOptionalProviderIds:
					preferences.enabledOptionalProviderIds.filter(
						(id) => id !== providerId
					),
			}
			const saved = saveSearchPreferences(nextPreferences)
			if (!saved) {
				setSaveMessage(null)
				setError('Unable to save search settings in this browser')
				return
			}
			setPreferences(nextPreferences)
			setError(null)
			setSaveMessage('Search settings saved')
		},
		[preferences]
	)

	const handleConfirmProvider = useCallback((): void => {
		if (!pendingProviderId) {
			return
		}
		const nextPreferences = {
			contentPolicyAcknowledgedVersion: CONTENT_USE_POLICY_VERSION,
			enabledOptionalProviderIds: [
				...new Set([
					...preferences.enabledOptionalProviderIds,
					pendingProviderId,
				]),
			].sort(),
		}
		if (!saveSearchPreferences(nextPreferences)) {
			setSaveMessage(null)
			setError('Unable to save search settings in this browser')
			setPendingProviderId(null)
			return
		}
		setPreferences(nextPreferences)
		setPendingProviderId(null)
		setError(null)
		setSaveMessage('Search settings saved')
	}, [pendingProviderId, preferences.enabledOptionalProviderIds])

	const handleCancelProvider = useCallback((): void => {
		setPendingProviderId(null)
	}, [])

	const handleAutomaticTranscriptionChange = useCallback(
		async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
			const enabled = event.currentTarget.checked
			setTranscriptionSettingsSaving(true)
			setTranscriptionError(null)
			try {
				const settings = await boundedSettingsRequest(
					captionApi,
					'write',
					(signal) => captionApi.updateSettings(enabled, signal)
				)
				setTranscriptionSettings(settings)
			} catch (value) {
				try {
					const confirmed = await boundedSettingsRequest(
						captionApi,
						'read',
						(signal) => captionApi.getSettings(signal)
					)
					setTranscriptionSettings(confirmed)
					let message: string | null = null
					if (confirmed.automaticTranscription !== enabled) {
						message =
							value instanceof Error
								? value.message
								: 'Unable to save transcription settings'
					}
					setTranscriptionError(message)
				} catch {
					setTranscriptionError(
						value instanceof Error
							? `${value.message} The saved setting could not be confirmed.`
							: 'Unable to save or confirm transcription settings'
					)
				}
			} finally {
				setTranscriptionSettingsSaving(false)
			}
		},
		[]
	)

	const freeProviders = providers.filter((provider) => provider.kind === 'free')
	const trackerProviders = providers.filter(
		(provider) => provider.kind === 'tracker'
	)
	const enabledProviderIds = enabledTrackerProviderIds(preferences, providers)
	const pendingProvider = providers.find(
		(provider) => provider.id === pendingProviderId
	)

	return (
		<PageShell>
			<ContentUseDialog
				action='enable-tracker'
				isOpen={pendingProvider !== undefined}
				onCancel={handleCancelProvider}
				onConfirm={handleConfirmProvider}
				sourceLabel={pendingProvider?.label}
			/>
			<Nav className=''>
				<Button aria-label='Back to library' asChild variant='outline'>
					<Link href='/'>
						<ArrowLeft aria-hidden='true' className='h-4 w-4' />
						<span className='hidden sm:inline'>Back to library</span>
					</Link>
				</Button>
				<h1 className='min-w-0 flex-1 truncate font-semibold text-lg'>
					Settings
				</h1>
				<ThemeToggle />
			</Nav>

			<PageContent className='space-y-10'>
				<section
					aria-labelledby='transcription-settings-heading'
					className='space-y-4'
				>
					<SectionHeading
						description='Create reusable captions from audio that is already fully available on this TPlayer server.'
						title='Transcription and captions'
						titleAs='h2'
						titleId='transcription-settings-heading'
					/>
					<Card className='p-4'>
						<div className='flex items-start gap-3'>
							<Checkbox
								aria-describedby={`${automaticTranscriptionId}-description`}
								checked={transcriptionSettings?.automaticTranscription ?? false}
								className='mt-1'
								disabled={
									transcriptionSettingsLoading ||
									transcriptionSettingsSaving ||
									transcriptionSettings === null
								}
								id={automaticTranscriptionId}
								onChange={handleAutomaticTranscriptionChange}
							/>
							<div className='min-w-0 flex-1'>
								<label
									className='cursor-pointer font-medium'
									htmlFor={automaticTranscriptionId}
								>
									Automatically transcribe audiobooks
								</label>
								<p
									className='mt-1 text-muted-foreground text-sm leading-relaxed'
									id={`${automaticTranscriptionId}-description`}
								>
									CouchSpeech runs against audio already stored on this server.
									Audiobook content is never uploaded to an external service.
									Turning this off cancels queued or running automatic jobs;
									completed captions remain available.
								</p>
							</div>
						</div>
						{transcriptionSettingsLoading ? (
							<p className='mt-3 text-muted-foreground text-sm' role='status'>
								Loading transcription settings…
							</p>
						) : null}
						{transcriptionSettingsSaving ? (
							<p className='sr-only' role='status'>
								Saving transcription settings
							</p>
						) : null}
						{transcriptionSettings?.cleanupPending ? (
							<p className='mt-3 text-muted-foreground text-sm' role='status'>
								{transcriptionSettings.automaticTranscription
									? 'Automatic transcription is on. TPlayer will resume eligible chapters after the previous attempt releases its local resources.'
									: 'Automatic transcription is off. TPlayer is finishing cancellation and releasing local resources.'}
							</p>
						) : null}
					</Card>
					{transcriptionError ? (
						<Alert role='alert' variant='destructive'>
							<CircleAlert aria-hidden='true' />
							<AlertDescription>{transcriptionError}</AlertDescription>
						</Alert>
					) : null}
				</section>

				<section aria-labelledby='search-sources-heading' className='space-y-6'>
					<SectionHeading
						description='Public-domain and rights-labelled catalogues are searched first. Unverified tracker sources are optional and stay off until you explicitly acknowledge the content policy.'
						title='Audiobook search sources'
						titleAs='h2'
						titleId='search-sources-heading'
					/>

					<ContentUseNotice includeThirdParty />

					{isLoading ? (
						<p className='text-muted-foreground' role='status'>
							Loading search sources…
						</p>
					) : null}

					{error ? (
						<Alert role='alert' variant='destructive'>
							<CircleAlert aria-hidden='true' />
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}

					{saveMessage && !error ? (
						<p className='sr-only' role='status'>
							{saveMessage}
						</p>
					) : null}

					{freeProviders.length > 0 ? (
						<div className='space-y-3'>
							<SectionHeading
								title='Public-domain and rights-labelled sources'
								titleAs='h3'
							/>
							<ul className='space-y-2'>
								{freeProviders.map((provider) => (
									<li key={provider.id}>
										<Card className='p-4'>
											<div className='flex items-start gap-3'>
												<span className='mt-0.5 grid size-6 place-items-center rounded-full bg-success/15 text-success'>
													<Check aria-hidden='true' className='h-3 w-3' />
												</span>
												<div className='min-w-0 flex-1'>
													<div className='flex items-center justify-between gap-2'>
														<span className='font-medium'>
															{provider.label}
														</span>
														<Badge variant='success'>Always on</Badge>
													</div>
													<p className='mt-1 text-muted-foreground text-sm'>
														{freeProviderDescription(provider)}
													</p>
													<div className='mt-2'>
														<ProviderHomepage
															homepage={provider.homepage}
															label={provider.label}
														/>
													</div>
												</div>
											</div>
										</Card>
									</li>
								))}
							</ul>
						</div>
					) : null}

					{isLoading ? null : (
						<div className='space-y-3'>
							<SectionHeading
								description='The first peer-to-peer action requires a policy acknowledgement. After that, each Open action applies only to the selected result without another checkbox.'
								title='Optional unverified tracker sources'
								titleAs='h3'
							/>
							{trackerProviders.length > 0 ? (
								<ul className='space-y-2'>
									{trackerProviders.map((provider) => (
										<TrackerProviderRow
											enabled={enabledProviderIds.includes(provider.id)}
											key={provider.id}
											onChange={handleProviderChange}
											provider={provider}
										/>
									))}
								</ul>
							) : (
								<p className='text-muted-foreground text-sm'>
									No optional tracker sources are available.
								</p>
							)}
						</div>
					)}
				</section>
			</PageContent>
		</PageShell>
	)
}

export default Settings
