const replacesActiveWorker = self.registration.active !== null

const refreshWindowClients = async () => {
	await self.clients.claim()
	if (!replacesActiveWorker) {
		return
	}
	const windowClients = await self.clients.matchAll({
		includeUncontrolled: true,
		type: 'window',
	})
	for (const client of windowClients) {
		client.navigate(client.url).catch(() => undefined)
	}
}

self.addEventListener('activate', (event) => {
	event.waitUntil(refreshWindowClients())
})
