import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Mirrors `getRuntimeGlobalConfigPath()` in src/config/runtime-config.ts for an explicit home dir. */
export function getGlobalConfigPathForHome(homeDir: string): string {
	return join(homeDir, ".cline", "kanban", "config.json");
}

/**
 * Opts a test's temp HOME into Worktree Mode by writing `worktreesEnabled: true`
 * into its Global_Config, preserving any existing keys.
 */
export function enableWorktreesForTest(homeDir: string): void {
	const configPath = getGlobalConfigPathForHome(homeDir);
	let existing: Record<string, unknown> = {};
	if (existsSync(configPath)) {
		const raw = readFileSync(configPath, "utf8").trim();
		if (raw.length > 0) {
			const parsed: unknown = JSON.parse(raw);
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
				existing = parsed as Record<string, unknown>;
			}
		}
	}
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, `${JSON.stringify({ ...existing, worktreesEnabled: true }, null, 2)}\n`, "utf8");
}
