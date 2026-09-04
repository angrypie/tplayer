import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'bun'
import { applicationRoot, loadConfig } from './config'

interface PathProbe {
	cacheDirectory: string
	databasePath: string
	frontendDirectory: string
}

const probeConfigFrom = async (
	workingDirectory: string
): Promise<PathProbe> => {
	const configUrl = pathToFileURL(
		join(applicationRoot, 'server/config.ts')
	).href
	const source = `
		const { loadConfig } = await import(${JSON.stringify(configUrl)})
		const config = loadConfig({})
		process.stdout.write(JSON.stringify({
			cacheDirectory: config.torrent.cacheDirectory,
			databasePath: config.databasePath,
			frontendDirectory: config.frontendDirectory,
		}))
	`
	const subprocess = spawn([process.execPath, '-e', source], {
		cwd: workingDirectory,
		stderr: 'pipe',
		stdout: 'pipe',
	})
	const [exitCode, stderr, stdout] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stderr).text(),
		new Response(subprocess.stdout).text(),
	])
	if (exitCode !== 0) {
		throw new Error(`Config probe failed: ${stderr}`)
	}
	return JSON.parse(stdout) as PathProbe
}

test('production state paths remain stable across unrelated working directories', async () => {
	const firstDirectory = await mkdtemp(join(tmpdir(), 'tplayer-config-one-'))
	const secondDirectory = await mkdtemp(join(tmpdir(), 'tplayer-config-two-'))
	try {
		const [first, second] = await Promise.all([
			probeConfigFrom(firstDirectory),
			probeConfigFrom(secondDirectory),
		])
		const expected: PathProbe = {
			cacheDirectory: join(applicationRoot, 'tplayer-cache'),
			databasePath: join(applicationRoot, 'tplayer_history.sqlite'),
			frontendDirectory: join(applicationRoot, 'dist'),
		}
		expect(first).toEqual(expected)
		expect(second).toEqual(expected)
	} finally {
		await Promise.all([
			rm(firstDirectory, { force: true, recursive: true }),
			rm(secondDirectory, { force: true, recursive: true }),
		])
	}
})

test('transcription runtime defaults are local and timeout overrides are validated', () => {
	expect(loadConfig({}).transcription).toEqual({
		ffmpegPath: 'ffmpeg',
		requestTimeoutMs: 10 * 60 * 1000,
	})
	expect(
		loadConfig({
			TPLAYER_FFMPEG_PATH: '/usr/local/bin/custom-ffmpeg',
			TPLAYER_TRANSCRIPTION_TIMEOUT_MS: '12345',
		}).transcription
	).toEqual({
		ffmpegPath: '/usr/local/bin/custom-ffmpeg',
		requestTimeoutMs: 12_345,
	})
	expect(() => loadConfig({ TPLAYER_TRANSCRIPTION_TIMEOUT_MS: '0' })).toThrow(
		'TPLAYER_TRANSCRIPTION_TIMEOUT_MS must be a positive integer'
	)
	expect(() =>
		loadConfig({ TPLAYER_TRANSCRIPTION_TIMEOUT_MS: '2147483648' })
	).toThrow('TPLAYER_TRANSCRIPTION_TIMEOUT_MS must be at most 2147483647')
})
