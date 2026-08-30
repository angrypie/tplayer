const M4B_EXTENSION_PATTERN = /\.m4b$/iu
const MEDIA_TYPE_PATTERN =
	/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu

const DEFAULT_MEDIA_TYPE = 'application/octet-stream'
const M4B_MEDIA_TYPE = 'audio/mp4'

const normalizedDetectedMediaType = (value: string): string | null => {
	const [mediaType = ''] = value.split(';', 1)
	const normalized = mediaType.trim().toLowerCase()
	return MEDIA_TYPE_PATTERN.test(normalized) ? normalized : null
}

export const torrentFileMediaType = (
	fileName: string,
	detectedMediaType: string
): string => {
	if (M4B_EXTENSION_PATTERN.test(fileName.trim())) {
		return M4B_MEDIA_TYPE
	}
	return normalizedDetectedMediaType(detectedMediaType) ?? DEFAULT_MEDIA_TYPE
}
