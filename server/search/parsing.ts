const HTML_TAG_PATTERN = /<[^>]*>/g
const WHITESPACE_PATTERN = /\s+/g
const NUMERIC_ENTITY_PATTERN = /&#(x?[\da-f]+);/gi
const ARCHIVE_IDENTIFIER_PATTERN = /^[a-z\d][a-z\d._-]{0,159}$/i
const ARCHIVE_HOSTS = new Set(['archive.org', 'www.archive.org'])
const MAXIMUM_UNICODE_CODE_POINT = 0x10_ff_ff
const SURROGATE_START = 0xd8_00
const SURROGATE_END = 0xdf_ff

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	amp: '&',
	apos: "'",
	gt: '>',
	lt: '<',
	nbsp: ' ',
	quot: '"',
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

export const readString = (
	value: Record<string, unknown>,
	key: string
): string | undefined =>
	typeof value[key] === 'string' ? value[key] : undefined

export const readFiniteNumber = (
	value: Record<string, unknown>,
	key: string
): number | undefined => {
	const candidate = value[key]
	if (typeof candidate === 'number' && Number.isFinite(candidate)) {
		return candidate
	}
	if (typeof candidate === 'string' && candidate.trim()) {
		const parsed = Number(candidate)
		return Number.isFinite(parsed) ? parsed : undefined
	}
	return undefined
}

export const readStringList = (value: unknown): string[] => {
	if (typeof value === 'string' && value.trim()) {
		return [value.trim()]
	}
	if (!Array.isArray(value)) {
		return []
	}
	return value.filter(
		(candidate): candidate is string =>
			typeof candidate === 'string' && candidate.trim().length > 0
	)
}

export const decodeEntities = (value: string): string =>
	value
		.replace(NUMERIC_ENTITY_PATTERN, (_match, rawCode: string) => {
			const hexadecimal = rawCode.toLowerCase().startsWith('x')
			const code = Number.parseInt(
				hexadecimal ? rawCode.slice(1) : rawCode,
				hexadecimal ? 16 : 10
			)
			const isUnicodeScalar =
				Number.isFinite(code) &&
				code <= MAXIMUM_UNICODE_CODE_POINT &&
				!(code >= SURROGATE_START && code <= SURROGATE_END)
			return isUnicodeScalar ? String.fromCodePoint(code) : ''
		})
		.replace(
			/&([a-z]+);/gi,
			(match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match
		)

export const plainText = (value: string, maximumLength = 600): string => {
	const normalized = decodeEntities(value)
		.replace(HTML_TAG_PATTERN, ' ')
		.replace(WHITESPACE_PATTERN, ' ')
		.trim()
	if (normalized.length <= maximumLength) {
		return normalized
	}
	return `${normalized.slice(0, maximumLength - 1).trimEnd()}…`
}

export const safeHttpUrl = (value: string | undefined): string | undefined => {
	if (!(value && URL.canParse(value))) {
		return undefined
	}
	const url = new URL(value)
	return url.protocol === 'http:' || url.protocol === 'https:'
		? url.toString()
		: undefined
}

export const validArchiveIdentifier = (value: string): boolean =>
	ARCHIVE_IDENTIFIER_PATTERN.test(value)

export const archiveIdentifierFromUrl = (
	value: string | undefined
): string | undefined => {
	if (!(value && URL.canParse(value))) {
		return undefined
	}
	const url = new URL(value)
	if (!ARCHIVE_HOSTS.has(url.hostname.toLowerCase())) {
		return undefined
	}
	const parts = url.pathname.split('/').filter(Boolean)
	const markerIndex = parts.findIndex(
		(part) => part === 'details' || part === 'download'
	)
	if (markerIndex < 0) {
		return undefined
	}
	const identifier = parts[markerIndex + 1]
	return identifier && validArchiveIdentifier(identifier)
		? identifier
		: undefined
}
