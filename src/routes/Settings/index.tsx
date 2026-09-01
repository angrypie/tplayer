import { ArrowLeft, Check, ExternalLink } from 'lucide-react'
import {
	type ChangeEvent,
	useCallback,
	useEffect,
	useId,
	useState,
} from 'react'
import { Link } from 'wouter'
import { ContentUseDialog } from '~/components/ContentUseDialog'
import { ContentUseNotice } from '~/components/ContentUseNotice'
import { Nav } from '~/components/layout/Nav'
import { ThemeToggle } from '~/components/theme-toggle'
import { Button } from '~/components/ui/button'
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
		<li className='rounded-lg border border-border bg-card p-4'>
			<div className='flex items-start gap-3'>
				<input
					checked={enabled}
					className='mt-1 h-4 w-4 shrink-0 accent-primary'
					id={inputId}
					onChange={handleChange}
					type='checkbox'
				/>
				<div className='min-w-0 flex-1'>
					<label className='cursor-pointer font-medium' htmlFor={inputId}>
						{provider.label}
					</label>
					<p className='mt-1 text-muted-foreground text-sm'>
						This independent tracker is off by default. TPlayer does not verify
						or endorse its listings or their rights status.
					</p>
					<div className='mt-2'>
						<ProviderHomepage
							homepage={provider.homepage}
							label={provider.label}
						/>
					</div>
				</div>
			</div>
		</li>
	)
}

const Settings = () => {
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

	const freeProviders = providers.filter((provider) => provider.kind === 'free')
	const trackerProviders = providers.filter(
		(provider) => provider.kind === 'tracker'
	)
	const enabledProviderIds = enabledTrackerProviderIds(preferences, providers)
	const pendingProvider = providers.find(
		(provider) => provider.id === pendingProviderId
	)

	return (
		<div className='flex h-screen flex-col'>
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

			<main className='flex-1 overflow-auto px-4 pt-3 pb-8'>
				<section aria-labelledby='search-sources-heading' className='space-y-5'>
					<div>
						<h2 className='font-bold text-2xl' id='search-sources-heading'>
							Audiobook search sources
						</h2>
						<p className='mt-1 text-muted-foreground text-sm'>
							Public-domain and rights-labelled catalogues are searched first.
							Unverified tracker sources are optional and stay off until you
							explicitly acknowledge the content policy.
						</p>
					</div>

					<ContentUseNotice includeThirdParty />

					{isLoading ? (
						<p className='text-muted-foreground' role='status'>
							Loading search sources…
						</p>
					) : null}

					{error ? (
						<p
							className='rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive text-sm'
							role='alert'
						>
							{error}
						</p>
					) : null}

					{saveMessage && !error ? (
						<p className='sr-only' role='status'>
							{saveMessage}
						</p>
					) : null}

					{freeProviders.length > 0 ? (
						<div className='space-y-2'>
							<h3 className='font-semibold text-lg'>
								Public-domain and rights-labelled sources
							</h3>
							<ul className='space-y-2'>
								{freeProviders.map((provider) => (
									<li
										className='rounded-lg border border-border bg-card p-4'
										key={provider.id}
									>
										<div className='flex items-start gap-3'>
											<span className='mt-0.5 rounded-full bg-primary p-1 text-primary-foreground'>
												<Check aria-hidden='true' className='h-3 w-3' />
											</span>
											<div className='min-w-0 flex-1'>
												<div className='flex items-center justify-between gap-2'>
													<span className='font-medium'>{provider.label}</span>
													<span className='text-muted-foreground text-xs'>
														Always on
													</span>
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
									</li>
								))}
							</ul>
						</div>
					) : null}

					{isLoading ? null : (
						<div className='space-y-2'>
							<h3 className='font-semibold text-lg'>
								Optional unverified tracker sources
							</h3>
							<p className='text-muted-foreground text-sm'>
								The first peer-to-peer action requires a policy acknowledgement.
								After that, each Open action applies only to the selected result
								without another checkbox.
							</p>
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
			</main>
		</div>
	)
}

export default Settings
