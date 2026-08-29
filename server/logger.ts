export interface LogContext {
	[key: string]: boolean | number | string | null | undefined
}

export interface AppLogger {
	debug: (message: string, context?: LogContext) => void
	error: (message: string, context?: LogContext) => void
	info: (message: string, context?: LogContext) => void
	warn: (message: string, context?: LogContext) => void
}

type LogLevel = 'debug' | 'error' | 'info' | 'warn'

const writeLog = (
	level: LogLevel,
	message: string,
	context?: LogContext
): void => {
	const entry = JSON.stringify({
		...context,
		level,
		message,
		timestamp: new Date().toISOString(),
	})
	const target = level === 'error' ? process.stderr : process.stdout
	target.write(`${entry}\n`)
}

export const logger: AppLogger = {
	debug: (message, context) => writeLog('debug', message, context),
	error: (message, context) => writeLog('error', message, context),
	info: (message, context) => writeLog('info', message, context),
	warn: (message, context) => writeLog('warn', message, context),
}
