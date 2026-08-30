const ignoreRegistrationFailure = (): void => undefined

export const registerServiceWorker = (): void => {
	if (!('serviceWorker' in navigator)) {
		return
	}

	const register = async () => {
		try {
			const registration = await navigator.serviceWorker.register('/sw.js', {
				scope: '/',
				updateViaCache: 'none',
			})
			await registration.update()
		} catch {
			ignoreRegistrationFailure()
		}
	}
	if (document.readyState === 'complete') {
		register()
		return
	}
	window.addEventListener('load', register, { once: true })
}
