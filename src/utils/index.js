import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

const COVER_NAME_PRIORITY = [
	'cover',
	'folder',
	'front',
	'poster',
	'art',
	'artwork',
]
const COVER_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif']
const DEFAULT_NORMALIZE_PATH = (pathParts) => pathParts
const AUDIO_FORMATS_BY_EXTENSION = new Map([
	['aac', 'aac'],
	['caf', 'caf'],
	['flac', 'flac'],
	['m4a', 'm4a'],
	['m4b', 'mp4'],
	['mp3', 'mp3'],
	['mp4', 'mp4'],
	['oga', 'oga'],
	['ogg', 'ogg'],
	['opus', 'opus'],
	['wav', 'wav'],
	['weba', 'weba'],
	['webm', 'webm'],
])
const AUDIO_FORMATS_BY_MIME_TYPE = new Map([
	['audio/aac', 'aac'],
	['audio/flac', 'flac'],
	['audio/mp4', 'm4a'],
	['audio/mpeg', 'mp3'],
	['audio/ogg', 'ogg'],
	['audio/opus', 'opus'],
	['audio/wav', 'wav'],
	['audio/webm', 'webm'],
	['audio/x-caf', 'caf'],
	['audio/x-m4a', 'm4a'],
	['audio/x-m4b', 'm4b'],
	['audio/x-wav', 'wav'],
])
const naturalCollator = new Intl.Collator('en', {
	numeric: true,
	sensitivity: 'base',
})

export const naturalCompare = (left, right) =>
	naturalCollator.compare(String(left), String(right))

const normalizeFileName = (pathParts, normalizePathParts) => {
	const normalizedParts = normalizePathParts(pathParts)
	const parts = Array.isArray(normalizedParts)
		? normalizedParts
		: [normalizedParts].filter(Boolean)
	const fileName = parts.at(-1) || ''
	return String(fileName).toLowerCase()
}

const getFileExtension = (fileName) => {
	const segments = fileName.split('.')
	return segments.length > 1 ? segments.pop() : ''
}

const isImageCandidate = (pathParts, normalizePathParts) => {
	const fileName = normalizeFileName(pathParts, normalizePathParts)
	const extension = getFileExtension(fileName)
	return COVER_EXTENSIONS.includes(extension)
}

const getCoverPriority = (pathParts, normalizePathParts) => {
	const fileName = normalizeFileName(pathParts, normalizePathParts)
	const extension = getFileExtension(fileName)
	const baseName = extension ? fileName.replace(`.${extension}`, '') : fileName
	const priority = COVER_NAME_PRIORITY.findIndex((name) =>
		baseName.includes(name)
	)
	return priority === -1 ? COVER_NAME_PRIORITY.length : priority
}

export const selectCoverCandidates = (
	files,
	normalizePathParts = DEFAULT_NORMALIZE_PATH
) => {
	const candidates = files.filter(
		(file) => file?.path && isImageCandidate(file.path, normalizePathParts)
	)
	return candidates.sort((a, b) => {
		const aName = normalizeFileName(a.path, normalizePathParts)
		const bName = normalizeFileName(b.path, normalizePathParts)
		const aPriority = getCoverPriority(a.path, normalizePathParts)
		const bPriority = getCoverPriority(b.path, normalizePathParts)
		if (aPriority !== bPriority) {
			return aPriority - bPriority
		}
		return naturalCompare(aName, bName)
	})
}

const appendPathParts = (value, parts) => {
	if (Array.isArray(value)) {
		for (const entry of value) {
			appendPathParts(entry, parts)
		}
		return
	}
	if (typeof value === 'string' && value.length > 0) {
		parts.push(value)
	}
}

export const normalizePath = (value) => {
	const parts = []
	appendPathParts(value, parts)
	return parts
}

export const comparePath = (a, b) =>
	normalizePath(a).join('/') === normalizePath(b).join('/')

export const getAudioFormat = (file) => {
	const pathParts = normalizePath(file?.path)
	const fileName = String(file?.name ?? pathParts.at(-1) ?? '').toLowerCase()
	const extension = getFileExtension(fileName)
	if (extension === 'm4b') {
		return AUDIO_FORMATS_BY_EXTENSION.get(extension)
	}

	const mimeType = file?.mimeType?.split(';', 1)[0]?.trim().toLowerCase()
	const mimeFormat = mimeType ? AUDIO_FORMATS_BY_MIME_TYPE.get(mimeType) : null
	if (mimeFormat) {
		return mimeFormat
	}

	return AUDIO_FORMATS_BY_EXTENSION.get(extension) ?? null
}

export const isAudioFile = (file) => getAudioFormat(file) !== null

export function cn(...inputs) {
	return twMerge(clsx(inputs))
}
