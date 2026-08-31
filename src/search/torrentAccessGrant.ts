let grantedInfoHash: string | null = null

const normalizeInfoHash = (infoHash: string): string =>
	infoHash.trim().toLowerCase()

export const grantTorrentServerAccess = (infoHash: string): void => {
	grantedInfoHash = normalizeInfoHash(infoHash)
}

export const consumeTorrentServerAccessGrant = (infoHash: string): boolean => {
	const normalizedInfoHash = normalizeInfoHash(infoHash)
	if (grantedInfoHash !== normalizedInfoHash) {
		return false
	}
	grantedInfoHash = null
	return true
}
