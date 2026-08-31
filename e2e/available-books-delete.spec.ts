import { expect, type Page, test } from '@playwright/test'

const INFO_HASH = 'b005811292e3fcee04dac588f29224cbc1c80629'
const BOOK_NAME = 'Partially downloaded audiobook'
const COLLECTION_ROUTE = '**/api/torrents'
const ITEM_ROUTE = `**/api/torrents/${INFO_HASH}`

const downloadingBook = {
	cachedBytes: 0,
	downloadedBytes: 346_030_080,
	downloadSpeed: 0,
	firstSeen: '2026-08-31T03:39:39.144Z',
	infoHash: INFO_HASH,
	lastSeen: '2026-08-31T03:40:00.093Z',
	metadataReady: true,
	name: BOOK_NAME,
	numPeers: 0,
	progress: 0.385,
	startedAt: '2026-08-31T03:39:39.146Z',
	state: 'downloading',
	totalBytes: 898_640_438,
}

const showAvailableBooks = async (page: Page): Promise<void> => {
	await page.goto('/')
	await page
		.getByRole('button', {
			exact: true,
			name: 'Show books available on server',
		})
		.click()
	await expect(page.getByText(BOOK_NAME, { exact: true })).toBeVisible()
}

test('shows bounded deletion progress and ignores a stale list response', async ({
	page,
}) => {
	let completeDelete = (): void => undefined
	let completeStaleList = (): void => undefined
	const deleteGate = new Promise<void>((resolve) => {
		completeDelete = resolve
	})
	const staleListGate = new Promise<void>((resolve) => {
		completeStaleList = resolve
	})
	let deleteCompleted = false
	let deleteRequests = 0
	let deleteStarted = false
	let listRequests = 0

	await page.route(COLLECTION_ROUTE, async (route) => {
		listRequests += 1
		if (deleteStarted && !deleteCompleted) {
			await staleListGate
		}
		await route.fulfill({ json: deleteCompleted ? [] : [downloadingBook] })
	})
	await page.route(ITEM_ROUTE, async (route) => {
		deleteRequests += 1
		deleteStarted = true
		await deleteGate
		deleteCompleted = true
		await route.fulfill({ body: '', status: 204 })
	})

	await showAvailableBooks(page)
	page.once('dialog', async (dialog) => {
		await dialog.accept()
	})
	await page.getByRole('button', { exact: true, name: 'Delete' }).click()

	const deletingButton = page.getByRole('button', {
		exact: true,
		name: 'Deleting…',
	})
	await expect(deletingButton).toBeDisabled()
	await expect(
		page.getByText('Stopping download and deleting cached files…', {
			exact: true,
		})
	).toBeVisible()
	await expect.poll(() => listRequests).toBeGreaterThan(1)
	expect(deleteRequests).toBe(1)

	completeDelete()
	await expect(page.getByText(BOOK_NAME, { exact: true })).toHaveCount(0)
	await expect(
		page.getByText('No books available on server', { exact: true })
	).toBeVisible()

	completeStaleList()
	await page.waitForTimeout(250)
	await expect(page.getByText(BOOK_NAME, { exact: true })).toHaveCount(0)
})

test('keeps the torrent visible and offers retry when deletion fails', async ({
	page,
}) => {
	await page.route(COLLECTION_ROUTE, async (route) => {
		await route.fulfill({ json: [downloadingBook] })
	})
	await page.route(ITEM_ROUTE, async (route) => {
		await route.fulfill({
			json: {
				error: {
					code: 'delete_failed',
					message: 'Unable to remove torrent data',
				},
			},
			status: 500,
		})
	})

	await showAvailableBooks(page)
	page.once('dialog', async (dialog) => {
		await dialog.accept()
	})
	await page.getByRole('button', { exact: true, name: 'Delete' }).click()

	await expect(page.getByRole('alert')).toContainText(
		'Delete failed: Unable to remove torrent data'
	)
	await expect(
		page.getByRole('button', { exact: true, name: 'Retry delete' })
	).toBeEnabled()
	await expect(page.getByText(BOOK_NAME, { exact: true })).toBeVisible()
})
