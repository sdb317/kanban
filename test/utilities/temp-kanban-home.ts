import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { type MockInstance, vi } from "vitest";
import { createGitTestEnv } from "./git-env.js";
import { createTempDir } from "./temp-dir.js";

export interface TempKanbanHome {
	/** Temp directory used as HOME / USERPROFILE / os.homedir(). */
	homeDir: string;
	/** Restores the previous env vars and homedir spy, then removes the temp directory. */
	cleanup: () => void;
}

export interface TempProject {
	path: string;
	cleanup: () => void;
}

/**
 * Points HOME, USERPROFILE, and os.homedir() at a fresh temp directory so the
 * runtime's Global_Config (`<home>/.cline/kanban/config.json`) is isolated per test.
 *
 * Note: `os.homedir()` reads HOME (POSIX) / USERPROFILE (Windows) on every call, so
 * the env overrides also cover modules that use the named `homedir` import, which a
 * spy on the default `os` export cannot intercept.
 */
export function withTempKanbanHome(prefix = "kanban-home-"): TempKanbanHome {
	const { path: homeDir, cleanup: removeDir } = createTempDir(prefix);
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = homeDir;
	process.env.USERPROFILE = homeDir;
	const homedirSpy: MockInstance<typeof os.homedir> = vi.spyOn(os, "homedir").mockReturnValue(homeDir);

	let cleanedUp = false;
	return {
		homeDir,
		cleanup: () => {
			if (cleanedUp) {
				return;
			}
			cleanedUp = true;
			homedirSpy.mockRestore();
			restoreEnv("HOME", previousHome);
			restoreEnv("USERPROFILE", previousUserProfile);
			removeDir();
		},
	};
}

/**
 * Creates a temp project folder. With `git: true` it runs `git init` and creates
 * an initial commit so HEAD resolves.
 */
export function createTempProject(options: { git: boolean; prefix?: string }): TempProject {
	const project = createTempDir(options.prefix ?? "kanban-project-");
	if (!options.git) {
		return project;
	}
	try {
		const env = createGitTestEnv();
		const runGit = (args: string[]): void => {
			execFileSync("git", args, { cwd: project.path, env, stdio: "ignore" });
		};
		runGit(["init", "--quiet"]);
		writeFileSync(join(project.path, "README.md"), "# temp project\n", "utf8");
		runGit(["add", "README.md"]);
		runGit(["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "initial commit"]);
	} catch (error) {
		project.cleanup();
		throw error;
	}
	return project;
}

function restoreEnv(key: "HOME" | "USERPROFILE", value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}
