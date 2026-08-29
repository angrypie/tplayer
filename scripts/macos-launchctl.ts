import {
	access,
	chmod,
	copyFile,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { sleep, spawn } from 'bun'

const SERVICE_LABEL = 'com.angrypie.tplayer'
const START_TIMEOUT_MS = 15_000
const HEALTH_URL = 'http://127.0.0.1:8082/api/health'
const projectRoot = resolve(import.meta.dir, '..')
const runnerPath = join(projectRoot, 'scripts/run-production.sh')
const serverBundlePath = join(projectRoot, 'build/server.js')
const frontendEntryPath = join(projectRoot, 'dist/index.html')
const launchAgentsDirectory = join(homedir(), 'Library/LaunchAgents')
const logsDirectory = join(homedir(), 'Library/Logs')
const plistPath = join(launchAgentsDirectory, `${SERVICE_LABEL}.plist`)
const backupPath = `${plistPath}.legacy-backup`
const stdoutPath = join(logsDirectory, `${SERVICE_LABEL}.out.log`)
const stderrPath = join(logsDirectory, `${SERVICE_LABEL}.err.log`)
const launchdDomain = `gui/${process.getuid?.() ?? 0}`
const serviceTarget = `${launchdDomain}/${SERVICE_LABEL}`

type Action =
	| 'install'
	| 'logs'
	| 'render'
	| 'restart'
	| 'start'
	| 'status'
	| 'stop'

interface CommandResult {
	exitCode: number
	stderr: string
	stdout: string
}

interface LaunchdState {
	loaded: boolean
	running: boolean
}

const writeLine = (message = ''): void => {
	process.stdout.write(`${message}\n`)
}

const writeError = (message: string): void => {
	process.stderr.write(`${message}\n`)
}

const escapeXml = (value: string): string =>
	value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;')

export const renderLaunchAgent = (bunBinary = process.execPath): string => {
	const path = `${dirname(bunBinary)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
	const value = (text: string): string => `<string>${escapeXml(text)}</string>`

	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		${value(path)}
		<key>TPLAYER_BUN_BIN</key>
		${value(bunBinary)}
		<key>TPLAYER_LAUNCHD</key>
		<string>1</string>
	</dict>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>Label</key>
	${value(SERVICE_LABEL)}
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		${value(runnerPath)}
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardErrorPath</key>
	${value(stderrPath)}
	<key>StandardOutPath</key>
	${value(stdoutPath)}
	<key>ThrottleInterval</key>
	<integer>5</integer>
	<key>WorkingDirectory</key>
	${value(projectRoot)}
</dict>
</plist>
`
}

const pathExists = async (path: string): Promise<boolean> => {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

const runCommand = async (
	command: string,
	arguments_: string[]
): Promise<CommandResult> => {
	const subprocess = spawn([command, ...arguments_], {
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

const requireSuccessfulCommand = async (
	command: string,
	arguments_: string[]
): Promise<CommandResult> => {
	const result = await runCommand(command, arguments_)
	if (result.exitCode !== 0) {
		throw new Error(
			`${command} ${arguments_.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`
		)
	}
	return result
}

const launchdState = async (): Promise<LaunchdState> => {
	const result = await runCommand('/bin/launchctl', ['print', serviceTarget])
	return {
		loaded: result.exitCode === 0,
		running: result.exitCode === 0 && result.stdout.includes('state = running'),
	}
}

const originHealthy = async (): Promise<boolean> => {
	try {
		const response = await fetch(HEALTH_URL, {
			signal: AbortSignal.timeout(750),
		})
		if (!response.ok) {
			return false
		}
		const body = (await response.json()) as { status?: unknown }
		return body.status === 'ok'
	} catch {
		return false
	}
}

const waitForService = async (
	deadline = performance.now() + START_TIMEOUT_MS
): Promise<void> => {
	const [state, healthy] = await Promise.all([launchdState(), originHealthy()])
	if (state.running && healthy) {
		return
	}
	if (performance.now() >= deadline) {
		throw new Error(
			`TPlayer did not become healthy within ${START_TIMEOUT_MS / 1000} seconds. Inspect ${stderrPath}`
		)
	}
	await sleep(250)
	await waitForService(deadline)
}

const ensureProductionArtifacts = async (): Promise<void> => {
	const requiredPaths = [runnerPath, serverBundlePath, frontendEntryPath]
	const pathAvailability = await Promise.all(
		requiredPaths.map(async (path) => ({
			exists: await pathExists(path),
			path,
		}))
	)
	const missingPaths = pathAvailability
		.filter((entry) => !entry.exists)
		.map((entry) => entry.path)
	if (missingPaths.length > 0) {
		throw new Error(
			`Production artifacts are missing:\n${missingPaths.join('\n')}\nRun "make prod" first.`
		)
	}
}

const printProductionConfig = async (): Promise<void> => {
	const result = await requireSuccessfulCommand('/bin/sh', [
		runnerPath,
		'--print-config',
	])
	process.stdout.write(result.stdout)
}

const bootoutIfLoaded = async (): Promise<boolean> => {
	const state = await launchdState()
	if (!state.loaded) {
		return false
	}
	await requireSuccessfulCommand('/bin/launchctl', [
		'bootout',
		launchdDomain,
		plistPath,
	])
	return true
}

const assertNoForegroundOrigin = async (): Promise<void> => {
	if (await originHealthy()) {
		throw new Error(
			'Port 8082 already has a healthy TPlayer origin. Stop foreground production before starting launchd.'
		)
	}
}

const writeLaunchAgent = async (): Promise<void> => {
	await Promise.all([
		mkdir(launchAgentsDirectory, { recursive: true }),
		mkdir(logsDirectory, { recursive: true }),
	])
	if ((await pathExists(plistPath)) && !(await pathExists(backupPath))) {
		await copyFile(plistPath, backupPath)
	}

	const temporaryPath = `${plistPath}.tmp`
	try {
		await writeFile(temporaryPath, renderLaunchAgent(), { mode: 0o644 })
		await chmod(temporaryPath, 0o644)
		await requireSuccessfulCommand('/usr/bin/plutil', ['-lint', temporaryPath])
		await rename(temporaryPath, plistPath)
	} catch (error) {
		await rm(temporaryPath, { force: true })
		throw error
	}
}

const bootstrap = async (): Promise<void> => {
	await requireSuccessfulCommand('/bin/launchctl', [
		'bootstrap',
		launchdDomain,
		plistPath,
	])
	await waitForService()
}

const install = async (): Promise<void> => {
	await ensureProductionArtifacts()
	await bootoutIfLoaded()
	await assertNoForegroundOrigin()
	await writeLaunchAgent()
	await bootstrap()
	writeLine(`Installed and started ${SERVICE_LABEL}`)
	writeLine(`LaunchAgent: ${plistPath}`)
	await printProductionConfig()
}

const start = async (): Promise<void> => {
	await ensureProductionArtifacts()
	const state = await launchdState()
	if (state.loaded) {
		await requireSuccessfulCommand('/bin/launchctl', [
			'kickstart',
			'-k',
			serviceTarget,
		])
		await waitForService()
	} else {
		await assertNoForegroundOrigin()
		if (!(await pathExists(plistPath))) {
			throw new Error(`LaunchAgent is not installed: ${plistPath}`)
		}
		await bootstrap()
	}
	writeLine(`Started ${SERVICE_LABEL}`)
}

const stop = async (): Promise<void> => {
	if (await bootoutIfLoaded()) {
		writeLine(`Stopped ${SERVICE_LABEL}`)
		return
	}
	writeLine(`${SERVICE_LABEL} is already stopped`)
}

const restart = async (): Promise<void> => {
	await ensureProductionArtifacts()
	await bootoutIfLoaded()
	await assertNoForegroundOrigin()
	if (!(await pathExists(plistPath))) {
		throw new Error(`LaunchAgent is not installed: ${plistPath}`)
	}
	await bootstrap()
	writeLine(`Restarted ${SERVICE_LABEL}`)
}

const status = async (): Promise<void> => {
	const [state, healthy] = await Promise.all([launchdState(), originHealthy()])
	let launchdStatus = 'stopped'
	if (state.running) {
		launchdStatus = 'running'
	} else if (state.loaded) {
		launchdStatus = 'loaded'
	}
	writeLine(`LaunchAgent: ${plistPath}`)
	writeLine(`launchd: ${launchdStatus}`)
	writeLine(`origin: ${healthy ? 'healthy' : 'unavailable'}`)
	await printProductionConfig()
	if (!(state.running && healthy)) {
		process.exitCode = 1
	}
}

const logs = async (): Promise<void> => {
	const paths = [stdoutPath, stderrPath]
	const outputs = await Promise.all(
		paths.map(async (path) => {
			try {
				const contents = await readFile(path, 'utf8')
				return contents.trimEnd().split('\n').slice(-100).join('\n')
			} catch {
				return '(no log output)'
			}
		})
	)
	for (const [index, path] of paths.entries()) {
		writeLine(`==> ${path} <==`)
		writeLine(outputs[index] ?? '(no log output)')
		writeLine()
	}
}

const parseAction = (value: string | undefined): Action => {
	if (
		value === 'install' ||
		value === 'logs' ||
		value === 'render' ||
		value === 'restart' ||
		value === 'start' ||
		value === 'status' ||
		value === 'stop'
	) {
		return value
	}
	throw new Error(
		'Expected one of: install, start, stop, restart, status, logs, render'
	)
}

const main = async (): Promise<void> => {
	const action = parseAction(process.argv[2])
	if (action === 'install') {
		await install()
		return
	}
	if (action === 'start') {
		await start()
		return
	}
	if (action === 'stop') {
		await stop()
		return
	}
	if (action === 'restart') {
		await restart()
		return
	}
	if (action === 'status') {
		await status()
		return
	}
	if (action === 'logs') {
		await logs()
		return
	}
	process.stdout.write(renderLaunchAgent())
}

if (import.meta.main) {
	try {
		await main()
	} catch (error) {
		writeError(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	}
}
