import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { getRuntimeGlobalConfigPath } from "../../src/config/runtime-config.js";
import { createGitTestEnv } from "./git-env.js";
import { createTempProject, withTempKanbanHome } from "./temp-kanban-home.js";
import { enableWorktreesForTest, getGlobalConfigPathForHome } from "./worktree-mode.js";

describe("withTempKanbanHome", () => {
	it("redirects homedir and the runtime global config path, then restores", () => {
		const previousHome = homedir();
		const home = withTempKanbanHome();
		try {
			expect(homedir()).toBe(home.homeDir);
			expect(getRuntimeGlobalConfigPath()).toBe(getGlobalConfigPathForHome(home.homeDir));
		} finally {
			home.cleanup();
		}
		expect(homedir()).toBe(previousHome);
		expect(existsSync(home.homeDir)).toBe(false);
	});
});

describe("createTempProject", () => {
	it("creates a plain folder without git", () => {
		const project = createTempProject({ git: false });
		try {
			expect(existsSync(project.path)).toBe(true);
			expect(existsSync(`${project.path}/.git`)).toBe(false);
		} finally {
			project.cleanup();
		}
		expect(existsSync(project.path)).toBe(false);
	});

	it("creates a git repo with an initial commit", () => {
		const project = createTempProject({ git: true });
		try {
			const head = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: project.path,
				env: createGitTestEnv(),
				encoding: "utf8",
			}).trim();
			expect(head).toMatch(/^[0-9a-f]{40}$/);
		} finally {
			project.cleanup();
		}
	});
});

describe("enableWorktreesForTest", () => {
	it("merges worktreesEnabled into existing global config", () => {
		const home = withTempKanbanHome();
		try {
			const configPath = getGlobalConfigPathForHome(home.homeDir);
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(configPath, JSON.stringify({ selectedAgentId: "cline" }), "utf8");
			enableWorktreesForTest(home.homeDir);
			expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
				selectedAgentId: "cline",
				worktreesEnabled: true,
			});
		} finally {
			home.cleanup();
		}
	});

	it("creates the global config when missing", () => {
		const home = withTempKanbanHome();
		try {
			enableWorktreesForTest(home.homeDir);
			expect(JSON.parse(readFileSync(getRuntimeGlobalConfigPath(), "utf8"))).toEqual({ worktreesEnabled: true });
		} finally {
			home.cleanup();
		}
	});
});
