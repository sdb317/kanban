// Cheap, hot-path loader for the effective worktree mode.
// Reads the Kanban global + project config files DIRECTLY: no file locks,
// no agent detection, no git. Called on every tRPC request and monitor tick,
// so it must stay allocation-light and never throw on missing/corrupt files.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getRuntimeGlobalConfigPath, getRuntimeProjectConfigPath } from "./runtime-config.js";
import {
	parseWorktreeSettingValue,
	resolveEffectiveWorktreesEnabled,
	type WorktreeSettingSources,
} from "./worktree-setting.js";

/**
 * Mirrors the home-dir equality rule in `resolveRuntimeConfigPaths`: a project
 * whose path equals the user's home directory has no project config, so its
 * `projectWorktreesEnabled` resolves to null (global/default applies).
 */
function normalizePathForComparison(path: string): string {
	const normalized = resolve(path).replaceAll("\\", "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Read a config file's raw `worktreesEnabled`, treating missing/unparsable files as unset (null). */
async function readWorktreesEnabledValue(configPath: string): Promise<boolean | null> {
	try {
		const raw = await readFile(configPath, "utf8");
		const parsed = JSON.parse(raw) as { worktreesEnabled?: unknown };
		return parseWorktreeSettingValue(parsed?.worktreesEnabled);
	} catch {
		return null;
	}
}

/** Resolve the project config path, or null when the project path is the user home directory. */
function resolveProjectConfigPath(projectPath: string): string | null {
	if (normalizePathForComparison(projectPath) === normalizePathForComparison(homedir())) {
		return null;
	}
	return getRuntimeProjectConfigPath(projectPath);
}

/**
 * Load both config sources with no locks, no agent detection, no git.
 * Passing `null` for `projectPath` loads only the global source (project null).
 */
export async function loadWorktreeSettingSources(projectPath: string | null): Promise<WorktreeSettingSources> {
	const projectConfigPath = projectPath === null ? null : resolveProjectConfigPath(projectPath);
	const [globalWorktreesEnabled, projectWorktreesEnabled] = await Promise.all([
		readWorktreesEnabledValue(getRuntimeGlobalConfigPath()),
		projectConfigPath === null ? Promise.resolve<boolean | null>(null) : readWorktreesEnabledValue(projectConfigPath),
	]);
	return { globalWorktreesEnabled, projectWorktreesEnabled };
}

/** Effective worktree mode for a project (project override -> global -> default false). */
export async function loadEffectiveWorktreesEnabled(projectPath: string): Promise<boolean> {
	return resolveEffectiveWorktreesEnabled(await loadWorktreeSettingSources(projectPath));
}

/** Effective worktree mode from the global config only (ignores any project override). */
export async function loadGlobalWorktreesEnabled(): Promise<boolean> {
	return resolveEffectiveWorktreesEnabled(await loadWorktreeSettingSources(null));
}
