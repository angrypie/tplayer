import { expect, test } from 'bun:test'
import {
	access,
	copyFile,
	mkdir,
	mkdtemp,
	rm,
	writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'bun'
import { renderLaunchAgent } from './macos-launchctl'

interface LaunchAgentDescriptor {
	EnvironmentVariables: Record<string, string>
	ProgramArguments: string[]
	WorkingDirectory: string
}

interface CommandResult {
	exitCode: number
	stderr: string
	stdout: string
}

const projectRoot = resolve(import.meta.dir, '..')
const runnerPath = join(projectRoot, 'scripts/run-production.sh')

const cleanProductionEnvironment = (): Record<string, string> => {
	const environment = Object.fromEntries(
		Object.entries(process.env).filter(
			([name, value]) => !(name.startsWith('TPLAYER_') || value === undefined)
		)
	) as Record<string, string>
	return environment
}

const run = async (
	command: string[],
	workingDirectory: string,
	environment: Record<string, string>
): Promise<CommandResult> => {
	const subprocess = spawn(command, {
		cwd: workingDirectory,
		env: environment,
		stderr: 'pipe',
		stdout: 'pipe',
	})
	const [exitCode, stderr, stdout] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stderr).text(),
		new Response(subprocess.stdout).text(),
	])
	return { exitCode, stderr, stdout }
}

const requireSuccess = (result: CommandResult): string => {
	if (result.exitCode !== 0) {
		throw new Error(result.stderr || result.stdout)
	}
	return result.stdout
}

const pathExists = async (path: string): Promise<boolean> => {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

test('terminal and generated launchd commands resolve one production runtime', async () => {
	const temporaryDirectory = await mkdtemp(
		join(tmpdir(), 'tplayer-production-paths-')
	)
	try {
		const environment = {
			...cleanProductionEnvironment(),
			TPLAYER_BUN_BIN: process.execPath,
		}
		const terminalConfig = requireSuccess(
			await run(
				['/bin/sh', runnerPath, '--print-config'],
				temporaryDirectory,
				environment
			)
		)

		const plistPath = join(temporaryDirectory, 'tplayer.plist')
		await writeFile(plistPath, renderLaunchAgent(process.execPath))
		requireSuccess(
			await run(
				['/usr/bin/plutil', '-lint', plistPath],
				temporaryDirectory,
				environment
			)
		)
		const descriptor = JSON.parse(
			requireSuccess(
				await run(
					['/usr/bin/plutil', '-convert', 'json', '-o', '-', plistPath],
					temporaryDirectory,
					environment
				)
			)
		) as LaunchAgentDescriptor
		const launchdConfig = requireSuccess(
			await run(
				[...descriptor.ProgramArguments, '--print-config'],
				descriptor.WorkingDirectory,
				{
					...cleanProductionEnvironment(),
					...descriptor.EnvironmentVariables,
				}
			)
		)

		expect(launchdConfig).toBe(terminalConfig)
		expect(terminalConfig).toContain(
			`TPLAYER_DATABASE_PATH=${join(projectRoot, 'tplayer_history.sqlite')}`
		)
		expect(terminalConfig).toContain(
			`TPLAYER_CACHE_DIR=${join(projectRoot, 'tplayer-cache')}`
		)
	} finally {
		await rm(temporaryDirectory, { force: true, recursive: true })
	}
})

test('production restore installs without the CouchSpeech source checkout', async () => {
	const temporaryDirectory = await mkdtemp(
		join(tmpdir(), 'tplayer-production-restore-')
	)
	try {
		await Promise.all([
			copyFile(
				join(projectRoot, 'package.json'),
				join(temporaryDirectory, 'package.json')
			),
			copyFile(
				join(projectRoot, 'bun.lock'),
				join(temporaryDirectory, 'bun.lock')
			),
			copyFile(
				join(projectRoot, 'bunfig.toml'),
				join(temporaryDirectory, 'bunfig.toml')
			),
		])
		const packageDirectory = join(temporaryDirectory, 'packages', 'captions')
		await mkdir(packageDirectory, { recursive: true })
		await copyFile(
			join(projectRoot, 'packages/captions/package.json'),
			join(packageDirectory, 'package.json')
		)

		requireSuccess(
			await run(
				[process.execPath, 'install', '--production', '--frozen-lockfile'],
				temporaryDirectory,
				cleanProductionEnvironment()
			)
		)

		expect(
			await pathExists(
				join(temporaryDirectory, 'node_modules/webtorrent/package.json')
			)
		).toBe(true)
		expect(
			await pathExists(join(temporaryDirectory, 'node_modules/@couchspeech'))
		).toBe(false)
		expect(
			await pathExists(join(temporaryDirectory, 'node_modules/@tplayer'))
		).toBe(false)
	} finally {
		await rm(temporaryDirectory, { force: true, recursive: true })
	}
}, 30_000)
