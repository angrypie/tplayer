export const reportBenchmark = (
	name: string,
	measurements: Readonly<Record<string, number | string>>
): void => {
	process.stdout.write(
		`BENCHMARK ${JSON.stringify({ bun: process.versions.bun ?? 'unknown', name, ...measurements })}\n`
	)
}
