export const safeExternalUrl = (value: string | undefined): string | null => {
	if (!(value && URL.canParse(value))) {
		return null
	}
	const url = new URL(value)
	return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
}
