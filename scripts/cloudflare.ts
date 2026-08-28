import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'

const API_BASE_URL =
	process.env.CLOUDFLARE_API_BASE_URL ?? 'https://api.cloudflare.com/client/v4'
const MANIFEST_PATH = resolve(
	process.env.TPLAYER_CLOUDFLARE_MANIFEST ?? 'cloudflare/desired-state.json'
)
const STATE_DIRECTORY = resolve('.cloudflare-state')
const REQUEST_TIMEOUT_MS = 15_000
const URL_PROTOCOL_PATTERN = /^https?:\/\//u
const TRAILING_SLASH_PATTERN = /\/$/u

type JsonObject = Record<string, unknown>

interface IngressRule extends JsonObject {
	hostname?: string
	originRequest?: JsonObject
	path?: string
	service: string
}

interface TunnelConfiguration {
	config: JsonObject & {
		ingress: IngressRule[]
	}
	created_at?: string
	source?: string
	tunnel_id?: string
	version?: number
}

interface Tunnel {
	config_src?: string
	deleted_at?: string | null
	id: string
	name: string
	status?: string
}

interface DnsRecord extends JsonObject {
	comment?: string
	content: string
	id: string
	name: string
	proxied?: boolean
	tags?: string[]
	ttl: number
	type: string
}

interface AccessDestination {
	type?: string
	uri?: string
}

interface AccessApplication extends JsonObject {
	destinations?: AccessDestination[]
	domain?: string
	id: string
	name?: string
	policies?: AccessPolicy[]
	session_duration?: string
	tags?: string[]
	type?: string
}

interface AccessRule extends JsonObject {
	email?: { email: string }
	email_domain?: { domain: string }
}

interface AccessPolicy extends JsonObject {
	decision?: string
	exclude?: AccessRule[]
	id: string
	include?: AccessRule[]
	name?: string
	precedence?: number
	require?: AccessRule[]
}

interface DesiredState {
	$schema?: string
	access: {
		applicationName: string
		emailDomainEnvironmentVariable: string
		emailEnvironmentVariable: string
		enabled: boolean
		managedTag: string
		policyName: string
		sessionDuration: string
	}
	accountId: string
	dns: {
		comment: string
		content: string
		name: string
		proxied: boolean
		ttl: number
		type: 'CNAME'
	}
	health: {
		apiPath: string
		expectAccessRedirect: boolean
		originUrl: string
		publicUrl: string
	}
	schemaVersion: 1
	tunnel: {
		hostname: string
		id: string
		name: string
		service: string
	}
	zoneId: string
	zoneName: string
}

interface RemoteState {
	accessApplication: AccessApplication | null
	accessPolicies: AccessPolicy[]
	dnsRecords: DnsRecord[]
	tunnel: Tunnel
	tunnelConfiguration: TunnelConfiguration
}

interface Snapshot {
	afterFingerprint?: string
	before: RemoteState
	createdAt: string
	manifestHash: string
	schemaVersion: 1
}

type ChangeKind = 'blocked' | 'create' | 'none' | 'replace' | 'update'

interface Change {
	detail: string
	kind: ChangeKind
	resource: string
}

interface Plan {
	changes: Change[]
	hasBlockers: boolean
	publicAccessDetected: boolean
	remote: RemoteState
}

interface Options {
	force: boolean
	replaceDns: boolean
	snapshotPath?: string
	yes: boolean
}

interface CloudflareEnvelope<T> {
	errors?: Array<{ code?: number; message?: string }>
	result: T
	success: boolean
}

class CloudflareApiError extends Error {
	readonly status: number

	constructor(path: string, status: number, messages: string[]) {
		super(
			`${path} failed (${status}): ${messages.join('; ') || 'unknown error'}`
		)
		this.name = 'CloudflareApiError'
		this.status = status
	}
}

class CloudflareClient {
	readonly token: string

	constructor(token: string) {
		this.token = token
	}

	async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
		const response = await fetch(`${API_BASE_URL}${path}`, {
			body: body === undefined ? undefined : JSON.stringify(body),
			headers: {
				Authorization: `Bearer ${this.token}`,
				'Content-Type': 'application/json',
			},
			method,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})

		const payload = (await response.json()) as CloudflareEnvelope<T>
		if (!(response.ok && payload.success)) {
			const messages = (payload.errors ?? []).map(
				(error) => `${error.code ?? 'unknown'}: ${error.message ?? 'unknown'}`
			)
			throw new CloudflareApiError(path, response.status, messages)
		}
		return payload.result
	}
}

const writeLine = (message = ''): void => {
	process.stdout.write(`${message}\n`)
}

const writeError = (message: string): void => {
	process.stderr.write(`${message}\n`)
}

const isObject = (value: unknown): value is JsonObject =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const requireString: (value: unknown, path: string) => asserts value is string =
	(value, path) => {
		if (typeof value !== 'string' || value.length === 0) {
			throw new Error(`${path} must be a non-empty string`)
		}
	}

const requireObject: (
	value: unknown,
	path: string
) => asserts value is JsonObject = (value, path) => {
	if (!isObject(value)) {
		throw new Error(`${path} must be an object`)
	}
}

const assertDesiredState: (value: unknown) => asserts value is DesiredState = (
	value
) => {
	requireObject(value, 'manifest')
	if (value.schemaVersion !== 1) {
		throw new Error('manifest.schemaVersion must be 1')
	}
	requireString(value.accountId, 'manifest.accountId')
	requireString(value.zoneId, 'manifest.zoneId')
	requireString(value.zoneName, 'manifest.zoneName')
	requireObject(value.tunnel, 'manifest.tunnel')
	requireString(value.tunnel.id, 'manifest.tunnel.id')
	requireString(value.tunnel.name, 'manifest.tunnel.name')
	requireString(value.tunnel.hostname, 'manifest.tunnel.hostname')
	requireString(value.tunnel.service, 'manifest.tunnel.service')
	requireObject(value.dns, 'manifest.dns')
	requireString(value.dns.name, 'manifest.dns.name')
	requireString(value.dns.content, 'manifest.dns.content')
	requireString(value.dns.comment, 'manifest.dns.comment')
	if (value.dns.type !== 'CNAME') {
		throw new Error('manifest.dns.type must be CNAME')
	}
	if (
		typeof value.dns.proxied !== 'boolean' ||
		typeof value.dns.ttl !== 'number'
	) {
		throw new Error('manifest.dns.proxied and manifest.dns.ttl are required')
	}
	requireObject(value.access, 'manifest.access')
	if (typeof value.access.enabled !== 'boolean') {
		throw new Error('manifest.access.enabled must be a boolean')
	}
	requireString(value.access.applicationName, 'manifest.access.applicationName')
	requireString(value.access.sessionDuration, 'manifest.access.sessionDuration')
	requireString(value.access.managedTag, 'manifest.access.managedTag')
	requireString(value.access.policyName, 'manifest.access.policyName')
	requireString(
		value.access.emailEnvironmentVariable,
		'manifest.access.emailEnvironmentVariable'
	)
	requireString(
		value.access.emailDomainEnvironmentVariable,
		'manifest.access.emailDomainEnvironmentVariable'
	)
	requireObject(value.health, 'manifest.health')
	requireString(value.health.originUrl, 'manifest.health.originUrl')
	requireString(value.health.publicUrl, 'manifest.health.publicUrl')
	requireString(value.health.apiPath, 'manifest.health.apiPath')
	if (typeof value.health.expectAccessRedirect !== 'boolean') {
		throw new Error('manifest.health.expectAccessRedirect must be a boolean')
	}

	const expectedDnsTarget = `${value.tunnel.id}.cfargotunnel.com`
	if (value.dns.content !== expectedDnsTarget) {
		throw new Error(`manifest.dns.content must be ${expectedDnsTarget}`)
	}
	if (value.dns.name !== value.tunnel.hostname) {
		throw new Error('manifest.dns.name must match manifest.tunnel.hostname')
	}
	if (!value.tunnel.hostname.endsWith(`.${value.zoneName}`)) {
		throw new Error('manifest.tunnel.hostname must belong to manifest.zoneName')
	}
}

const loadDesiredState = async (): Promise<DesiredState> => {
	const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as unknown
	assertDesiredState(manifest)
	return manifest
}

const canonicalize = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map(canonicalize)
	}
	if (!isObject(value)) {
		return value
	}
	const result: JsonObject = {}
	for (const key of Object.keys(value).sort()) {
		result[key] = canonicalize(value[key])
	}
	return result
}

const stableStringify = (value: unknown): string =>
	JSON.stringify(canonicalize(value))

const hashValue = (value: unknown): string =>
	createHash('sha256').update(stableStringify(value)).digest('hex')

const valuesEqual = (left: unknown, right: unknown): boolean =>
	stableStringify(left) === stableStringify(right)

const isCatchAll = (rule: IngressRule): boolean =>
	rule.hostname === undefined && rule.path === undefined

const desiredIngressRule = (manifest: DesiredState): IngressRule => ({
	hostname: manifest.tunnel.hostname,
	originRequest: {},
	service: manifest.tunnel.service,
})

const reconcileIngress = (
	ingress: IngressRule[],
	manifest: DesiredState
): IngressRule[] => {
	const unrelatedRules = ingress.filter(
		(rule) => rule.hostname !== manifest.tunnel.hostname && !isCatchAll(rule)
	)
	const existingCatchAll = ingress.find(isCatchAll)
	return [
		...unrelatedRules,
		desiredIngressRule(manifest),
		existingCatchAll ?? { service: 'http_status:404' },
	]
}

const normalizeHostname = (value: string): string =>
	value
		.replace(URL_PROTOCOL_PATTERN, '')
		.replace(TRAILING_SLASH_PATTERN, '')
		.toLowerCase()

const applicationMatchesHostname = (
	application: AccessApplication,
	hostname: string
): boolean => {
	if (
		application.domain &&
		normalizeHostname(application.domain) === hostname
	) {
		return true
	}
	return (application.destinations ?? []).some(
		(destination) =>
			destination.uri !== undefined &&
			normalizeHostname(destination.uri) === hostname
	)
}

const parseCsvEnvironment = (name: string): string[] => {
	const rawValue = process.env[name] ?? ''
	const uniqueValues = new Set<string>()
	for (const value of rawValue.split(',')) {
		const normalized = value.trim().toLowerCase()
		if (normalized) {
			uniqueValues.add(normalized)
		}
	}
	return [...uniqueValues].sort()
}

const desiredAccessRules = (manifest: DesiredState): AccessRule[] => {
	const rules: AccessRule[] = []
	for (const email of parseCsvEnvironment(
		manifest.access.emailEnvironmentVariable
	)) {
		rules.push({ email: { email } })
	}
	for (const domain of parseCsvEnvironment(
		manifest.access.emailDomainEnvironmentVariable
	)) {
		rules.push({ email_domain: { domain } })
	}
	return rules
}

const accessApplicationBody = (manifest: DesiredState): JsonObject => ({
	destinations: [{ type: 'public', uri: manifest.tunnel.hostname }],
	name: manifest.access.applicationName,
	session_duration: manifest.access.sessionDuration,
	tags: [manifest.access.managedTag],
	type: 'self_hosted',
})

const accessPolicyBody = (
	manifest: DesiredState,
	include: AccessRule[]
): JsonObject => ({
	decision: 'allow',
	include,
	name: manifest.access.policyName,
})

const dnsRecordBody = (manifest: DesiredState): JsonObject => ({
	comment: manifest.dns.comment,
	content: manifest.dns.content,
	name: manifest.dns.name,
	proxied: manifest.dns.proxied,
	ttl: manifest.dns.ttl,
	type: manifest.dns.type,
})

const restoreDnsRecordBody = (record: DnsRecord): JsonObject => {
	const body: JsonObject = {
		content: record.content,
		name: record.name,
		proxied: record.proxied,
		ttl: record.ttl,
		type: record.type,
	}
	if (record.comment !== undefined) {
		body.comment = record.comment
	}
	if (record.tags !== undefined) {
		body.tags = record.tags
	}
	if (record.settings !== undefined) {
		body.settings = record.settings
	}
	return body
}

const restorePolicyBody = (policy: AccessPolicy): JsonObject => {
	const body: JsonObject = {
		decision: policy.decision ?? 'allow',
		include: policy.include ?? [],
		name: policy.name ?? 'Restored policy',
	}
	if (policy.exclude !== undefined) {
		body.exclude = policy.exclude
	}
	if (policy.require !== undefined) {
		body.require = policy.require
	}
	if (policy.precedence !== undefined) {
		body.precedence = policy.precedence
	}
	return body
}

const getRemoteState = async (
	client: CloudflareClient,
	manifest: DesiredState
): Promise<RemoteState> => {
	const accountPath = `/accounts/${manifest.accountId}`
	const zonePath = `/zones/${manifest.zoneId}`
	const [tunnel, tunnelConfiguration, dnsRecords, accessApplications] =
		await Promise.all([
			client.request<Tunnel>(`${accountPath}/cfd_tunnel/${manifest.tunnel.id}`),
			client.request<TunnelConfiguration>(
				`${accountPath}/cfd_tunnel/${manifest.tunnel.id}/configurations`
			),
			client.request<DnsRecord[]>(
				`${zonePath}/dns_records?name=${encodeURIComponent(manifest.dns.name)}&per_page=100`
			),
			manifest.access.enabled
				? client.request<AccessApplication[]>(
						`${accountPath}/access/apps?per_page=100`
					)
				: Promise.resolve([]),
		])

	const matchingApplications = accessApplications.filter((application) =>
		applicationMatchesHostname(application, manifest.tunnel.hostname)
	)
	if (matchingApplications.length > 1) {
		throw new Error(
			`Multiple Access applications match ${manifest.tunnel.hostname}; resolve them manually`
		)
	}
	const accessApplication = matchingApplications[0] ?? null
	const accessPolicies = accessApplication
		? await client.request<AccessPolicy[]>(
				`${accountPath}/access/apps/${accessApplication.id}/policies?per_page=100`
			)
		: []

	return {
		accessApplication,
		accessPolicies,
		dnsRecords,
		tunnel,
		tunnelConfiguration,
	}
}

const isDesiredDnsRecord = (
	record: DnsRecord,
	manifest: DesiredState
): boolean =>
	record.type === manifest.dns.type &&
	record.name === manifest.dns.name &&
	record.content === manifest.dns.content &&
	record.proxied === manifest.dns.proxied &&
	record.ttl === manifest.dns.ttl &&
	(record.comment ?? '') === manifest.dns.comment

const publicAccessIsActive = async (
	manifest: DesiredState
): Promise<boolean> => {
	const response = await fetch(manifest.health.publicUrl, {
		method: 'HEAD',
		redirect: 'manual',
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	})
	const location = response.headers.get('location') ?? ''
	return (
		response.status >= 300 &&
		response.status < 400 &&
		(location.includes('/cdn-cgi/access/') ||
			location.includes('.cloudflareaccess.com/'))
	)
}

const planTunnel = (remote: RemoteState, manifest: DesiredState): Change[] => {
	const identityMatches =
		remote.tunnel.id === manifest.tunnel.id &&
		remote.tunnel.name === manifest.tunnel.name
	const identityChange: Change = identityMatches
		? {
				detail: `${remote.tunnel.name} is ${remote.tunnel.status ?? 'available'}`,
				kind: 'none',
				resource: 'tunnel',
			}
		: {
				detail: `Expected tunnel ${manifest.tunnel.name} (${manifest.tunnel.id})`,
				kind: 'blocked',
				resource: 'tunnel',
			}

	const currentIngress = remote.tunnelConfiguration.config.ingress
	const nextIngress = reconcileIngress(currentIngress, manifest)
	const ingressMatches = valuesEqual(nextIngress, currentIngress)
	const ingressChange: Change = {
		detail: ingressMatches
			? `${manifest.tunnel.hostname} already routes to ${manifest.tunnel.service}`
			: `Merge ${manifest.tunnel.hostname} -> ${manifest.tunnel.service}; preserve unrelated routes`,
		kind: ingressMatches ? 'none' : 'update',
		resource: 'tunnel ingress',
	}
	return [identityChange, ingressChange]
}

const planDns = (remote: RemoteState, manifest: DesiredState): Change => {
	if (remote.dnsRecords.length === 0) {
		return {
			detail: `Create proxied CNAME ${manifest.dns.name} -> ${manifest.dns.content}`,
			kind: 'create',
			resource: 'DNS',
		}
	}
	const [record] = remote.dnsRecords
	if (
		record &&
		remote.dnsRecords.length === 1 &&
		isDesiredDnsRecord(record, manifest)
	) {
		return {
			detail: `${manifest.dns.name} already matches desired state`,
			kind: 'none',
			resource: 'DNS',
		}
	}
	if (record?.type === 'CNAME' && remote.dnsRecords.length === 1) {
		return {
			detail: `Update existing CNAME ${manifest.dns.name}`,
			kind: 'update',
			resource: 'DNS',
		}
	}
	return {
		detail: `Replace ${remote.dnsRecords.length} conflicting record(s); requires --replace-dns`,
		kind: 'replace',
		resource: 'DNS',
	}
}

const planAccessApplication = (
	remote: RemoteState,
	manifest: DesiredState,
	publicAccessDetected: boolean
): Change[] => {
	const { accessApplication: application } = remote
	if (!application && publicAccessDetected) {
		return [
			{
				detail:
					'Public Access is active but the API returned no application; use a token with Access Apps and Policies permission',
				kind: 'blocked',
				resource: 'Access',
			},
		]
	}
	if (!application) {
		return [
			{
				detail: `Create Access application ${manifest.access.applicationName}`,
				kind: 'create',
				resource: 'Access application',
			},
		]
	}
	if ((application.tags ?? []).includes(manifest.access.managedTag)) {
		const applicationMatches = valuesEqual(
			accessApplicationBody(manifest),
			accessApplicationBodyFromRemote(application)
		)
		return [
			{
				detail: `Reconcile managed application ${manifest.access.applicationName}`,
				kind: applicationMatches ? 'none' : 'update',
				resource: 'Access application',
			},
		]
	}

	const changes: Change[] = [
		{
			detail: `Existing application ${application.name ?? application.id} is not tagged ${manifest.access.managedTag}; review and tag it before onboarding`,
			kind: 'blocked',
			resource: 'Access application',
		},
	]
	if (!remote.accessPolicies.some((policy) => policy.decision === 'allow')) {
		changes.push({
			detail: 'The external Access application has no Allow policy',
			kind: 'blocked',
			resource: 'Access policy',
		})
	}
	return changes
}

const policyChangeKind = (
	policy: AccessPolicy | undefined,
	desiredPolicy: JsonObject
): ChangeKind => {
	if (!policy) {
		return 'create'
	}
	return valuesEqual(desiredPolicy, accessPolicyBodyFromRemote(policy))
		? 'none'
		: 'update'
}

const planManagedAccessPolicy = (
	remote: RemoteState,
	manifest: DesiredState
): Change[] => {
	const application = remote.accessApplication
	const isManaged =
		!application ||
		(application.tags ?? []).includes(manifest.access.managedTag)
	if (!isManaged) {
		return []
	}
	const rules = desiredAccessRules(manifest)
	if (rules.length === 0) {
		return [
			{
				detail: `Set ${manifest.access.emailEnvironmentVariable} or ${manifest.access.emailDomainEnvironmentVariable}`,
				kind: 'blocked',
				resource: 'Access policy',
			},
		]
	}
	if (!application) {
		return [
			{
				detail: `Create ${manifest.access.policyName} with the Access application`,
				kind: 'create',
				resource: 'Access policy',
			},
		]
	}
	const matchingPolicies = remote.accessPolicies.filter(
		(candidate) => candidate.name === manifest.access.policyName
	)
	if (matchingPolicies.length > 1) {
		return [
			{
				detail: `Multiple policies named ${manifest.access.policyName}`,
				kind: 'blocked',
				resource: 'Access policy',
			},
		]
	}
	const [existingPolicy] = matchingPolicies
	return [
		{
			detail: `${existingPolicy ? 'Reconcile' : 'Create'} ${manifest.access.policyName}`,
			kind: policyChangeKind(existingPolicy, accessPolicyBody(manifest, rules)),
			resource: 'Access policy',
		},
	]
}

const planAccess = (
	remote: RemoteState,
	manifest: DesiredState,
	publicAccessDetected: boolean
): Change[] => {
	if (!manifest.access.enabled) {
		return []
	}
	return [
		...planAccessApplication(remote, manifest, publicAccessDetected),
		...planManagedAccessPolicy(remote, manifest),
	]
}

const buildPlan = async (
	client: CloudflareClient,
	manifest: DesiredState
): Promise<Plan> => {
	const remote = await getRemoteState(client, manifest)
	const publicAccessDetected = manifest.access.enabled
		? await publicAccessIsActive(manifest)
		: false
	const changes = [
		...planTunnel(remote, manifest),
		planDns(remote, manifest),
		...planAccess(remote, manifest, publicAccessDetected),
	]
	return {
		changes,
		hasBlockers: changes.some((change) => change.kind === 'blocked'),
		publicAccessDetected,
		remote,
	}
}

const accessApplicationBodyFromRemote = (
	application: AccessApplication
): JsonObject => ({
	destinations: application.destinations ?? [],
	name: application.name,
	session_duration: application.session_duration,
	tags: application.tags ?? [],
	type: application.type,
})

const accessPolicyBodyFromRemote = (policy: AccessPolicy): JsonObject => ({
	decision: policy.decision,
	include: policy.include ?? [],
	name: policy.name,
})

const printPlan = (plan: Plan): void => {
	writeLine('Cloudflare desired-state plan')
	for (const change of plan.changes) {
		writeLine(`[${change.kind}] ${change.resource}: ${change.detail}`)
	}
}

const fingerprintRemoteState = (state: RemoteState): string =>
	hashValue({
		accessApplication: state.accessApplication,
		accessPolicies: state.accessPolicies,
		dnsRecords: state.dnsRecords,
		tunnelConfiguration: state.tunnelConfiguration.config,
	})

const saveSnapshot = async (
	manifest: DesiredState,
	remote: RemoteState
): Promise<{ path: string; snapshot: Snapshot }> => {
	await mkdir(STATE_DIRECTORY, { mode: 0o700, recursive: true })
	const timestamp = new Date().toISOString().replace(/[:.]/gu, '-')
	const path = resolve(STATE_DIRECTORY, `cloudflare-${timestamp}.json`)
	const snapshot: Snapshot = {
		before: remote,
		createdAt: new Date().toISOString(),
		manifestHash: hashValue(manifest),
		schemaVersion: 1,
	}
	await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, {
		mode: 0o600,
	})
	await chmod(path, 0o600)
	return { path, snapshot }
}

const updateSnapshotAfterApply = async (
	path: string,
	snapshot: Snapshot,
	remote: RemoteState
): Promise<void> => {
	snapshot.afterFingerprint = fingerprintRemoteState(remote)
	await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, {
		mode: 0o600,
	})
	await chmod(path, 0o600)
}

const reconcileAccess = async (
	client: CloudflareClient,
	manifest: DesiredState,
	remote: RemoteState
): Promise<void> => {
	if (!manifest.access.enabled) {
		return
	}
	const accountPath = `/accounts/${manifest.accountId}`
	const rules = desiredAccessRules(manifest)
	let application = remote.accessApplication
	if (!application) {
		application = await client.request<AccessApplication>(
			`${accountPath}/access/apps`,
			'POST',
			accessApplicationBody(manifest)
		)
	} else if ((application.tags ?? []).includes(manifest.access.managedTag)) {
		application = await client.request<AccessApplication>(
			`${accountPath}/access/apps/${application.id}`,
			'PUT',
			accessApplicationBody(manifest)
		)
	} else {
		return
	}

	const policies = await client.request<AccessPolicy[]>(
		`${accountPath}/access/apps/${application.id}/policies?per_page=100`
	)
	const matchingPolicies = policies.filter(
		(policy) => policy.name === manifest.access.policyName
	)
	if (matchingPolicies.length > 1) {
		throw new Error(`Multiple policies named ${manifest.access.policyName}`)
	}
	const [existingPolicy] = matchingPolicies
	const path = `${accountPath}/access/apps/${application.id}/policies`
	if (existingPolicy) {
		await client.request(
			`${path}/${existingPolicy.id}`,
			'PUT',
			accessPolicyBody(manifest, rules)
		)
	} else {
		await client.request(path, 'POST', accessPolicyBody(manifest, rules))
	}
}

const reconcileTunnel = async (
	client: CloudflareClient,
	manifest: DesiredState,
	remote: RemoteState
): Promise<void> => {
	const ingress = reconcileIngress(
		remote.tunnelConfiguration.config.ingress,
		manifest
	)
	if (valuesEqual(ingress, remote.tunnelConfiguration.config.ingress)) {
		return
	}
	await client.request(
		`/accounts/${manifest.accountId}/cfd_tunnel/${manifest.tunnel.id}/configurations`,
		'PUT',
		{ config: { ...remote.tunnelConfiguration.config, ingress } }
	)
}

const reconcileDns = async (
	client: CloudflareClient,
	manifest: DesiredState,
	remote: RemoteState,
	replaceDns: boolean
): Promise<void> => {
	const path = `/zones/${manifest.zoneId}/dns_records`
	if (
		remote.dnsRecords.length === 1 &&
		isDesiredDnsRecord(remote.dnsRecords[0], manifest)
	) {
		return
	}
	if (
		remote.dnsRecords.length === 1 &&
		remote.dnsRecords[0]?.type === 'CNAME'
	) {
		await client.request(
			`${path}/${remote.dnsRecords[0].id}`,
			'PUT',
			dnsRecordBody(manifest)
		)
		return
	}
	if (remote.dnsRecords.length > 0 && !replaceDns) {
		throw new Error('Conflicting DNS records require --replace-dns')
	}
	await Promise.all(
		remote.dnsRecords.map((record) =>
			client.request(`${path}/${record.id}`, 'DELETE')
		)
	)
	await client.request(path, 'POST', dnsRecordBody(manifest))
}

const applyPlan = async (
	client: CloudflareClient,
	manifest: DesiredState,
	plan: Plan,
	options: Options
): Promise<string> => {
	if (plan.hasBlockers) {
		throw new Error('Resolve blocked plan items before applying')
	}
	if (
		plan.changes.some((change) => change.kind === 'replace') &&
		!options.replaceDns
	) {
		throw new Error('The plan requires --replace-dns')
	}

	const { path, snapshot } = await saveSnapshot(manifest, plan.remote)
	writeLine(`Rollback snapshot: ${path}`)
	await reconcileAccess(client, manifest, plan.remote)
	await reconcileTunnel(client, manifest, plan.remote)
	await reconcileDns(client, manifest, plan.remote, options.replaceDns)
	const after = await getRemoteState(client, manifest)
	await updateSnapshotAfterApply(path, snapshot, after)
	return path
}

const restoreDns = async (
	client: CloudflareClient,
	manifest: DesiredState,
	before: DnsRecord[]
): Promise<void> => {
	const path = `/zones/${manifest.zoneId}/dns_records`
	const current = await client.request<DnsRecord[]>(
		`${path}?name=${encodeURIComponent(manifest.dns.name)}&per_page=100`
	)
	await Promise.all(
		current.map((record) => client.request(`${path}/${record.id}`, 'DELETE'))
	)
	await Promise.all(
		before.map((record) =>
			client.request(path, 'POST', restoreDnsRecordBody(record))
		)
	)
}

const restoreAccess = async (
	client: CloudflareClient,
	manifest: DesiredState,
	before: RemoteState,
	current: RemoteState
): Promise<void> => {
	if (!manifest.access.enabled) {
		return
	}
	const accountPath = `/accounts/${manifest.accountId}`
	if (!before.accessApplication) {
		if (current.accessApplication?.tags?.includes(manifest.access.managedTag)) {
			await client.request(
				`${accountPath}/access/apps/${current.accessApplication.id}`,
				'DELETE'
			)
		}
		return
	}
	if (
		!(before.accessApplication.tags ?? []).includes(manifest.access.managedTag)
	) {
		return
	}
	if (!current.accessApplication) {
		throw new Error(
			'Managed Access application is missing; restore it manually'
		)
	}

	await client.request(
		`${accountPath}/access/apps/${current.accessApplication.id}`,
		'PUT',
		accessApplicationBodyFromRemote(before.accessApplication)
	)
	const policyPath = `${accountPath}/access/apps/${current.accessApplication.id}/policies`
	await Promise.all(
		current.accessPolicies
			.filter((candidate) => candidate.name === manifest.access.policyName)
			.map((policy) => client.request(`${policyPath}/${policy.id}`, 'DELETE'))
	)
	await Promise.all(
		before.accessPolicies
			.filter((candidate) => candidate.name === manifest.access.policyName)
			.map((policy) =>
				client.request(policyPath, 'POST', restorePolicyBody(policy))
			)
	)
}

const rollback = async (
	client: CloudflareClient,
	manifest: DesiredState,
	options: Options
): Promise<void> => {
	if (!options.snapshotPath) {
		throw new Error('Usage: bun run cloudflare:rollback -- <snapshot> --yes')
	}
	const snapshot = JSON.parse(
		await readFile(resolve(options.snapshotPath), 'utf8')
	) as Snapshot
	if (snapshot.schemaVersion !== 1 || !snapshot.before) {
		throw new Error('Unsupported rollback snapshot')
	}
	if (snapshot.manifestHash !== hashValue(manifest) && !options.force) {
		throw new Error(
			'Desired-state manifest changed; use --force after reviewing the diff'
		)
	}
	const current = await getRemoteState(client, manifest)
	if (
		snapshot.afterFingerprint &&
		snapshot.afterFingerprint !== fingerprintRemoteState(current) &&
		!options.force
	) {
		throw new Error(
			'Cloudflare state changed after this snapshot; use --force only after reviewing newer changes'
		)
	}
	if (!options.yes) {
		throw new Error('Rollback requires --yes')
	}

	await client.request(
		`/accounts/${manifest.accountId}/cfd_tunnel/${manifest.tunnel.id}/configurations`,
		'PUT',
		{ config: snapshot.before.tunnelConfiguration.config }
	)
	await restoreDns(client, manifest, snapshot.before.dnsRecords)
	await restoreAccess(client, manifest, snapshot.before, current)
	writeLine(`Restored Cloudflare state captured at ${snapshot.createdAt}`)
}

const verifyRuntime = async (manifest: DesiredState): Promise<void> => {
	const originRoot = await fetch(manifest.health.originUrl, {
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	})
	if (!originRoot.ok) {
		throw new Error(`Origin root returned ${originRoot.status}`)
	}
	const originApi = await fetch(
		new URL(manifest.health.apiPath, manifest.health.originUrl),
		{ signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
	)
	if (!originApi.ok) {
		throw new Error(`Origin API returned ${originApi.status}`)
	}
	const apiPayload = (await originApi.json()) as unknown
	if (!Array.isArray(apiPayload)) {
		throw new Error('Origin API did not return an array')
	}

	const publicResponse = await fetch(manifest.health.publicUrl, {
		redirect: 'manual',
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	})
	if (manifest.health.expectAccessRedirect) {
		const location = publicResponse.headers.get('location') ?? ''
		if (
			publicResponse.status < 300 ||
			publicResponse.status >= 400 ||
			!(
				location.includes('/cdn-cgi/access/') ||
				location.includes('.cloudflareaccess.com/')
			)
		) {
			throw new Error(
				`Public URL did not redirect to Cloudflare Access (status ${publicResponse.status})`
			)
		}
	} else if (!publicResponse.ok) {
		throw new Error(`Public URL returned ${publicResponse.status}`)
	}
	writeLine(
		'Runtime verification passed: origin UI/API and public Access boundary'
	)
}

const verifyDesiredState = async (
	client: CloudflareClient,
	manifest: DesiredState
): Promise<void> => {
	const plan = await buildPlan(client, manifest)
	printPlan(plan)
	const drift = plan.changes.filter((change) => change.kind !== 'none')
	if (drift.length > 0) {
		throw new Error(
			`Cloudflare desired state has ${drift.length} unresolved item(s)`
		)
	}
	await verifyRuntime(manifest)
	writeLine('Cloudflare desired-state verification passed')
}

const confirmApply = async (): Promise<boolean> => {
	if (!(stdin.isTTY && stdout.isTTY)) {
		return false
	}
	const prompt = createInterface({ input: stdin, output: stdout })
	try {
		const answer = await prompt.question('Apply this Cloudflare plan? [y/N] ')
		return ['y', 'yes'].includes(answer.trim().toLowerCase())
	} finally {
		prompt.close()
	}
}

const parseOptions = (args: string[]): Options => {
	const positional = args.filter((argument) => !argument.startsWith('--'))
	return {
		force: args.includes('--force'),
		replaceDns: args.includes('--replace-dns'),
		snapshotPath: positional[1],
		yes: args.includes('--yes'),
	}
}

const requireClient = (): CloudflareClient => {
	const token = process.env.CLOUDFLARE_API_TOKEN
	if (!token) {
		throw new Error(
			'CLOUDFLARE_API_TOKEN is required; see cloudflare/onboarding.md for scoped permissions'
		)
	}
	return new CloudflareClient(token)
}

const selfTest = (manifest: DesiredState): void => {
	const existing: IngressRule[] = [
		{ hostname: 'couchview.angrypie.dev', service: 'http://localhost:4173' },
		{ service: 'http_status:404' },
	]
	const expected: IngressRule[] = [
		existing[0] as IngressRule,
		desiredIngressRule(manifest),
		existing[1] as IngressRule,
	]
	assert.deepEqual(reconcileIngress(existing, manifest), expected)
	assert.deepEqual(reconcileIngress(expected, manifest), expected)
	assert.equal(
		applicationMatchesHostname(
			{
				destinations: [{ type: 'public', uri: manifest.tunnel.hostname }],
				id: 'test',
			},
			manifest.tunnel.hostname
		),
		true
	)
	assert.equal(hashValue(manifest).length, 64)
	writeLine('Cloudflare onboarding self-test passed')
}

const printHelp = (): void => {
	writeLine('TPlayer Cloudflare desired-state onboarding')
	writeLine('')
	writeLine('Commands:')
	writeLine(
		'  validate                    Validate the versioned manifest offline'
	)
	writeLine(
		'  runtime                     Check the local origin and public Access boundary'
	)
	writeLine(
		'  plan                        Read Cloudflare and show the proposed changes'
	)
	writeLine('  onboard [--yes]             Plan, apply, and verify')
	writeLine('  apply --yes                 Apply a previously reviewed plan')
	writeLine(
		'  verify                      Verify Cloudflare and runtime desired state'
	)
	writeLine('  rollback <snapshot> --yes   Restore a local rollback snapshot')
	writeLine(
		'  self-test                   Test reconciliation without Cloudflare access'
	)
	writeLine('')
	writeLine('Safety flags: --replace-dns, --force')
}

const main = async (): Promise<void> => {
	const args = process.argv.slice(2)
	const command = args[0] ?? 'help'
	const options = parseOptions(args)
	const manifest = await loadDesiredState()

	if (command === 'help' || command === '--help' || command === '-h') {
		printHelp()
		return
	}
	if (command === 'validate') {
		writeLine(`Validated ${MANIFEST_PATH}`)
		return
	}
	if (command === 'runtime') {
		await verifyRuntime(manifest)
		return
	}
	if (command === 'self-test') {
		selfTest(manifest)
		return
	}

	const client = requireClient()
	if (command === 'plan') {
		printPlan(await buildPlan(client, manifest))
		return
	}
	if (command === 'verify') {
		await verifyDesiredState(client, manifest)
		return
	}
	if (command === 'rollback') {
		await rollback(client, manifest, options)
		return
	}
	if (command === 'apply' || command === 'onboard') {
		const plan = await buildPlan(client, manifest)
		printPlan(plan)
		const approved =
			options.yes || (command === 'onboard' && (await confirmApply()))
		if (!approved) {
			throw new Error(
				'No changes applied; rerun with --yes after reviewing the plan'
			)
		}
		await applyPlan(client, manifest, plan, options)
		await verifyDesiredState(client, manifest)
		return
	}
	throw new Error(`Unknown command: ${command}`)
}

try {
	await main()
} catch (error) {
	const message = error instanceof Error ? error.message : String(error)
	writeError(`Cloudflare onboarding failed: ${message}`)
	process.exitCode = 1
}
