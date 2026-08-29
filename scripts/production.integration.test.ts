import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
