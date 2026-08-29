import { HttpError } from '../errors'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const HEX_INFO_HASH_PATTERN = /^[a-f\d]{40}$/i
const BASE32_INFO_HASH_PATTERN = /^[a-z2-7]{32}$/i
const BITTORRENT_EXACT_TOPIC_PREFIX = 'urn:btih:'
const UNSAFE_METADATA_LOCATION_PARAMETERS = new Set(['as', 'xs'])

export interface TorrentReference {
	infoHash: string
	torrentId: string
}

const decodeBase32InfoHash = (value: string): string => {
	let accumulator = 0
	let bits = 0
	const bytes: number[] = []
	for (const character of value.toUpperCase()) {
		const next = BASE32_ALPHABET.indexOf(character)
		if (next < 0) {
			throw new HttpError(400, 'invalid_torrent', 'Invalid base32 info hash')
		}
		accumulator = accumulator * 32 + next
		bits += 5
		if (bits >= 8) {
			bits -= 8
			bytes.push(Math.trunc(accumulator / 2 ** bits) % 256)
			accumulator %= 2 ** bits
		}
	}
	return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const decodeParameterName = (value: string): string => {
	try {
		return decodeURIComponent(value.replaceAll('+', ' ')).toLowerCase()
	} catch {
		return value.toLowerCase()
	}
}

const removeUnsafeMetadataLocations = (magnet: string): string => {
	const queryStart = magnet.indexOf('?')
	if (queryStart < 0) {
		return magnet
	}
	const prefix = magnet.slice(0, queryStart + 1)
	const parameters = magnet.slice(queryStart + 1).split('&')
	const safeParameters = parameters.filter((parameter) => {
		const [rawName = ''] = parameter.split('=', 1)
		const name = decodeParameterName(rawName)
		return !UNSAFE_METADATA_LOCATION_PARAMETERS.has(name)
	})
	return `${prefix}${safeParameters.join('&')}`
}

export const normalizeInfoHash = (value: string): string => {
	const trimmed = value.trim()
	if (HEX_INFO_HASH_PATTERN.test(trimmed)) {
		return trimmed.toLowerCase()
	}
	if (BASE32_INFO_HASH_PATTERN.test(trimmed)) {
		return decodeBase32InfoHash(trimmed)
	}
	throw new HttpError(
		400,
		'invalid_torrent',
		'Expected a 40-character hex or 32-character base32 info hash'
	)
}

export const parseTorrentReference = (value: string): TorrentReference => {
	const trimmed = value.trim()
	if (!trimmed) {
		throw new HttpError(
			400,
			'invalid_torrent',
			'Torrent identifier is required'
		)
	}
	if (
		HEX_INFO_HASH_PATTERN.test(trimmed) ||
		BASE32_INFO_HASH_PATTERN.test(trimmed)
	) {
		const infoHash = normalizeInfoHash(trimmed)
		return { infoHash, torrentId: infoHash }
	}

	if (!URL.canParse(trimmed)) {
		throw new HttpError(400, 'invalid_torrent', 'Invalid magnet URI')
	}
	const magnet = new URL(trimmed)
	if (magnet.protocol !== 'magnet:') {
		throw new HttpError(
			400,
			'invalid_torrent',
			'Only magnet URIs are supported'
		)
	}
	const exactTopic = magnet.searchParams
		.getAll('xt')
		.find((topic) =>
			topic.toLowerCase().startsWith(BITTORRENT_EXACT_TOPIC_PREFIX)
		)
	if (!exactTopic) {
		throw new HttpError(
			400,
			'invalid_torrent',
			'Magnet URI does not contain a BitTorrent info hash'
		)
	}
	const infoHash = normalizeInfoHash(
		exactTopic.slice(BITTORRENT_EXACT_TOPIC_PREFIX.length)
	)
	return { infoHash, torrentId: removeUnsafeMetadataLocations(trimmed) }
}
