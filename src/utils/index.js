import { clsx } from "clsx"
import natsort from "natsort"
import { twMerge } from "tailwind-merge"

const COVER_NAME_PRIORITY = ['cover', 'folder', 'front', 'poster', 'art', 'artwork']
const COVER_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif']
const DEFAULT_NORMALIZE_PATH = (pathParts) => pathParts

const normalizeFileName = (pathParts, normalizePathParts) => {
	const normalizedParts = normalizePathParts(pathParts)
	const parts = Array.isArray(normalizedParts) ? normalizedParts : [normalizedParts].filter(Boolean)
	const fileName = parts[parts.length - 1] || ''
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
	const priority = COVER_NAME_PRIORITY.findIndex((name) => baseName.includes(name))
	return priority === -1 ? COVER_NAME_PRIORITY.length : priority
}

export const selectCoverCandidates = (files, normalizePathParts = DEFAULT_NORMALIZE_PATH) => {
	const candidates = files.filter((file) => file?.path && isImageCandidate(file.path, normalizePathParts))
	return candidates.sort((a, b) => {
		const aName = normalizeFileName(a.path, normalizePathParts)
		const bName = normalizeFileName(b.path, normalizePathParts)
		const aPriority = getCoverPriority(a.path, normalizePathParts)
		const bPriority = getCoverPriority(b.path, normalizePathParts)
		if (aPriority !== bPriority) {
			return aPriority - bPriority
		}
		return natsort()(aName, bName)
	})
}

export const comparePath = (a, b) => a.join('/') === b.join('')


export function cn(...inputs) {
	return twMerge(clsx(inputs))
}

