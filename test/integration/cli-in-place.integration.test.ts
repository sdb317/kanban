import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";
import { createTempProject, type TempProject } from "../utilities/temp-kanban-home";

const requireFromHere = createRequire(import.meta.url);

function resolveShutdownIpcHookPath(): string {
	return resolve(process.cwd(), "test/integration/shutdown-ipc-hook.cjs");
}

function resolveTsxLoaderImportSpecifier(): string {
	return pathToFileURL(requireFromHere.resolve("tsx")).href;
}

async function getAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", () => {
			resolveListen();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : null;
	await new Promise<void>((resolveClose, rejectClose) => {
		server.close((error) => {
			if (error) {
				rejectClose(error);
				return;
			}
			resolveClose();
		});
	});
	if (!port) {
		throw new Error("Could not allocate a test port.");
	}
	return port;
}

async function waitForServerStart(serverProcess: ChildProcess, timeoutMs = 10_000): Promise<void> {
	await new Promise<void>((resolveStart, rejectStart) => {
		if (!serverProcess.stdout || !serverProcess.stderr) {
			rejectStart(new Error("Expected child process stdout/stderr pipes to be available."));
			return;
		}
		let settled = false;
		let stdout = "";
		let stderr = "";
		const timeoutId = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			rejectStart(new Error(`Timed out waiting for server start.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
		}, timeoutMs);
		const handleOutput = (chunk: Buffer, source: "stdout" | "stderr") => {
			const text = chunk.toString();
			if (source === "stdout") {
				stdout += text;
			} else {
				stderr += text;
			}
			if (!stdout.includes("Kanban running at ") || settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			resolveStart();
		};
		serverProcess.stdout.on("data", (chunk: Buffer) => {
			handleOutput(chunk, "stdout");
		});
		serverProcess.stderr.on("data", (chunk: Buffer) => {
			handleOutput(chunk, "stderr");
		});
		serverProcess.once("exit", (code, signal) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			rejectStart(
				new Error(
					`Server process exited before startup (code=${String(code)} signal=${String(signal)}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				),
			);
		});
	});
}

async function waitForExit(childProcess: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (childProcess.exitCode !== null) {
		return true;
	}
	return await new Promise<boolean>((resolveExit) => {
		const handleExit = () => {
			clearTimeout(timeoutId);
			resolveExit(true);
		};
		const timeoutId = setTimeout(() => {
			childProcess.removeListener("exit", handleExit);
			resolveExit(false);
		}, timeoutMs);
		childProcess.once("exit", handleExit);
	});
}

async function requestGracefulShutdown(serverProcess: ChildProcess): Promise<void> {
	if (typeof serverProcess.send !== "function" || !serverProcess.connected) {
		serverProcess.kill("SIGINT");
		return;
	}
	await new Promise<void>((resolveSend) => {
		serverProcess.send?.({ type: "kanban.shutdown" }, () => {
			resolveSend();
		});
	});
}

function spawnSourceCli(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
	const cliEntrypoint = resolve(process.cwd(), "src/cli.ts");
	return spawn(process.execPath, ["--import", resolveTsxLoaderImportSpecifier(), cliEntrypoint, ...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

async function runCliCommandAndCollectOutput(options: {
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null; didExit: boolean }> {
	const commandProcess = spawnSourceCli(options.args, {
		cwd: options.cwd,
		env: options.env,
	});

	let stdout = "";
	let stderr = "";
	commandProcess.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	commandProcess.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});

	const didExit = await waitForExit(commandProcess, options.timeoutMs ?? 8_000);
	if (!didExit) {
		commandProcess.kill("SIGKILL");
	}

	return {
		stdout,
		stderr,
		exitCode: commandProcess.exitCode,
		didExit,
	};
}

interface CreatedTaskPayload {
	ok?: boolean;
	task?: {
		id?: string;
		baseRef?: string;
		autoReviewEnabled?: boolean;
		autoReviewMode?: string;
	};
}

describe.sequential("cli in-place mode integration", () => {
	let homeDir: string;
	let cleanupHome: () => void;
	let project: TempProject;
	let serverProcess: ChildProcess | null = null;
	let port: string;
	let env: NodeJS.ProcessEnv;

	beforeEach(async () => {
		// Fresh temp HOME dir; global Global_Config is absent, so worktreesEnabled
		// resolves to its default `false` (In-Place Mode). We intentionally do NOT
		// call enableWorktreesForTest here.
		const home = createTempDir("kanban-home-in-place-");
		homeDir = home.path;
		cleanupHome = home.cleanup;
		// Non-git project folder: In-Place Mode must work without any git setup.
		project = createTempProject({ git: false, prefix: "kanban-project-in-place-" });

		port = String(await getAvailablePort());
		env = createGitTestEnv({
			HOME: homeDir,
			USERPROFILE: homeDir,
			KANBAN_RUNTIME_PORT: port,
		});
	});

	afterEach(async () => {
		if (serverProcess) {
			await requestGracefulShutdown(serverProcess);
			const stopped = await waitForExit(serverProcess, 5_000);
			if (!stopped) {
				serverProcess.kill("SIGKILL");
				await waitForExit(serverProcess, 5_000);
			}
			serverProcess = null;
		}
		project.cleanup();
		cleanupHome();
	});

	async function launchRuntimeFromProject(): Promise<ChildProcess> {
		const launched = spawn(
			process.execPath,
			[
				"--require",
				resolveShutdownIpcHookPath(),
				"--import",
				resolveTsxLoaderImportSpecifier(),
				resolve(process.cwd(), "src/cli.ts"),
				"--no-open",
			],
			{
				cwd: project.path,
				env,
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			},
		);
		await waitForServerStart(launched);
		return launched;
	}

	it(
		"launches from a non-git cwd, registers it, and never creates a .git directory",
		{ timeout: 60_000 },
		async () => {
			// Req 10.6: launching from a non-git cwd starts the runtime and registers
			// that directory as a project without a git-related error.
			serverProcess = await launchRuntimeFromProject();

			// Registration is observable via the CLI: `task list` resolves the workspace
			// for the non-git project and succeeds.
			const listed = await runCliCommandAndCollectOutput({
				args: ["task", "list", "--project-path", project.path],
				cwd: project.path,
				env,
			});
			expect(
				listed.didExit,
				`task list did not exit in time.\nstdout:\n${listed.stdout}\nstderr:\n${listed.stderr}`,
			).toBe(true);
			expect(listed.exitCode).toBe(0);
			expect(listed.stdout).toContain('"ok": true');
			// Non-git launch must not initialize git in the project folder (Req 10.4/10.6).
			expect(existsSync(join(project.path, ".git"))).toBe(false);
		},
	);

	it(
		"creates a task without --base-ref in a non-git project, exiting 0 with an empty baseRef and no branch lookup error",
		{ timeout: 60_000 },
		async () => {
			// Req 10.8 + 10.3: `task create` without `--base-ref` in a non-git project
			// succeeds, stores "" as the baseRef, and prints no git branch lookup error.
			serverProcess = await launchRuntimeFromProject();

			const created = await runCliCommandAndCollectOutput({
				args: [
					"task",
					"create",
					"--prompt",
					"Add a welcome banner to the landing page in the shared project folder",
					"--project-path",
					project.path,
				],
				cwd: project.path,
				env,
			});

			expect(
				created.didExit,
				`task create did not exit in time.\nstdout:\n${created.stdout}\nstderr:\n${created.stderr}`,
			).toBe(true);
			expect(created.exitCode).toBe(0);
			expect(created.stdout).toContain('"ok": true');
			expect(created.stdout).not.toContain("Could not determine task base branch");

			const payload = JSON.parse(created.stdout) as CreatedTaskPayload;
			expect(payload.ok).toBe(true);
			expect(typeof payload.task?.id).toBe("string");
			expect(payload.task?.baseRef).toBe("");
		},
	);

	it(
		"creates a task with --base-ref in a non-git project, storing the supplied value unchanged",
		{ timeout: 60_000 },
		async () => {
			// Req 10.8 + 10.2: `task create` with a caller-supplied `--base-ref` in a
			// non-git project succeeds and stores the supplied string unchanged, with no
			// validation against git branches.
			serverProcess = await launchRuntimeFromProject();

			const suppliedBaseRef = "feature/in-place-base-ref";
			const created = await runCliCommandAndCollectOutput({
				args: [
					"task",
					"create",
					"--prompt",
					"Wire up the settings panel while sharing the project folder",
					"--project-path",
					project.path,
					"--base-ref",
					suppliedBaseRef,
				],
				cwd: project.path,
				env,
			});

			expect(
				created.didExit,
				`task create did not exit in time.\nstdout:\n${created.stdout}\nstderr:\n${created.stderr}`,
			).toBe(true);
			expect(created.exitCode).toBe(0);
			expect(created.stdout).toContain('"ok": true');
			expect(created.stdout).not.toContain("Could not determine task base branch");

			const payload = JSON.parse(created.stdout) as CreatedTaskPayload;
			expect(payload.ok).toBe(true);
			expect(payload.task?.baseRef).toBe(suppliedBaseRef);
		},
	);

	it(
		"stores --auto-review-enabled and --auto-review-mode values on a task created in In-Place Mode",
		{ timeout: 60_000 },
		async () => {
			// Req 7.5: valid `--auto-review-enabled` / `--auto-review-mode` values on
			// `task create` are stored on the task and the CLI exits with success.
			serverProcess = await launchRuntimeFromProject();

			const created = await runCliCommandAndCollectOutput({
				args: [
					"task",
					"create",
					"--prompt",
					"Refactor the data layer while auto-review settings are provided",
					"--project-path",
					project.path,
					"--auto-review-enabled",
					"true",
					"--auto-review-mode",
					"pr",
				],
				cwd: project.path,
				env,
			});

			expect(
				created.didExit,
				`task create did not exit in time.\nstdout:\n${created.stdout}\nstderr:\n${created.stderr}`,
			).toBe(true);
			expect(created.exitCode).toBe(0);

			const payload = JSON.parse(created.stdout) as CreatedTaskPayload;
			expect(payload.ok).toBe(true);
			expect(payload.task?.autoReviewEnabled).toBe(true);
			expect(payload.task?.autoReviewMode).toBe("pr");
		},
	);
});
