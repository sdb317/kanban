/**
 * Expected shell-quoted command line for the current platform, mirroring
 * `quoteShellArg` in src/core/shell.ts: double quotes on Windows, single quotes elsewhere.
 * Written out literally so tests still assert the concrete quoting format.
 */
export function expectedShellCommandLine(...parts: string[]): string {
	const quote = process.platform === "win32" ? '"' : "'";
	return parts.map((part) => `${quote}${part}${quote}`).join(" ");
}
