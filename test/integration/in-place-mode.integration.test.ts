import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import type {
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeGitSummaryResponse,
	RuntimeHookIngestResponse,
	RuntimeShellSessionStartResponse,
	RuntimeWorkspaceChangesResponse,
	RuntimeWorkspaceStateResponse,
	RuntimeWorktreeEnsureResponse,
} from "../../src/core/api-contract";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

const requireFromHere = createRequire(import.meta.url);

/**
 * Feature: in-place-workspace-mode, Task 17: end-to-end filesystem guarantees.
 *
 * These tests drive a real runtime server with the global worktree setting left
 * at its default (`false`, i.e. In-Place Mode). We intentionally do NOT call
 * `enableWorktreesForTest`: the absence of `worktreesEnabled` in Global_Config is
 * the In-Place default under test.
 *
 * The core guarantee (Req 14.2/14.3, 3.4, 3.5, 6.4): the runtime itself touches
 * nothing in the Project_Path outside `<project>/.kanban`, spawns no git for
 * checkpoints, creates no worktree under `~/.cline/worktrees`, and leaves
 * `refs/kanban/checkpoints/*` unchanged while running task start, a `to_review`
 * hook, trash, restore, and permanent delete through the runtime API.
 */

function resolveShutdownIpcHookPath(): string {
	return resolve(process.cwd(), "test/integration/shutdown-ipc-hook.cjs");
}

function resolveTsxLoaderImportSpecifier(): string {
	return pathToFileURL(requireFromHere.resolve("tsx")).href;
}

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function initGitRepositoryWithCommit(path: string): void {
	runGit(path, ["init", "--quiet"]);
	runGit(path, ["checkout", "-B", "main"]);
	writeFileSync(join(path, "README.md"), "# in-place project\n", "utf8");
	writeFileSync(join(path, "src.txt"), "tracked source\n", "utf8");
	// A gitignored path: in Worktree Mode this would be mirrored and the managed
	// block appended to `.git/info/exclude`. In-Place Mode must leave it alone.
	writeFileSync(join(path, ".gitignore"), "/node_modules/\n", "utf8");
	mkdirSync(join(path, "node_modules"), { recursive: true });
	writeFileSync(join(path, "node_modules", "package.json"), '{\n  "name": "fixture"\n}\n', "utf8");
	runGit(path, ["add", "README.md", "src.txt", ".gitignore"]);
	runGit(path, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "initial commit"]);
	// A second branch so `git branch --list` has more than one entry to compare.
	runGit(path, ["branch", "feature/extra"]);
}

/** A recursive snapshot of every path under `root` with file contents and entry kinds. */
interface PathSnapshot {
	/** Relative POSIX path → "dir" for directories, file contents for files, "symlink" for links. */
	entries: Map<string, string>;
}

function toPosix(relativePath: string): string {
	return relativePath.split(sep).join("/");
}

function snapshotPaths(root: string, options: { excludePrefixes: string[] }): PathSnapshot {
	const entries = new Map<string, string>();
	const excludePrefixes = options.excludePrefixes.map((prefix) => toPosix(prefix));

	const isExcluded = (relativePosix: string): boolean =>
		excludePrefixes.some((prefix) => relativePosix === prefix || relativePosix.startsWith(`${prefix}/`));

	const walk = (absolute: string): void => {
		const dirEntries = readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of dirEntries) {
			const childAbsolute = join(absolute, entry.name);
			const relativePosix = toPosix(relative(root, childAbsolute));
			if (isExcluded(relativePosix)) {
				continue;
			}
			if (entry.isSymbolicLink()) {
				entries.set(relativePosix, "symlink");
				continue;
			}
			if (entry.isDirectory()) {
				entries.set(relativePosix, "dir");
				walk(childAbsolute);
				continue;
			}
			entries.set(relativePosix, readFileSync(childAbsolute, "utf8"));
		}
	};

	walk(root);
	return { entries };
}

function expectSnapshotsEqual(before: PathSnapshot, after: PathSnapshot): void {
	const beforeKeys = [...before.entries.keys()].sort();
	const afterKeys = [...after.entries.keys()].sort();
	expect(afterKeys).toEqual(beforeKeys);
	for (const key of beforeKeys) {
		expect(after.entries.get(key), `content of ${key} changed`).toBe(before.entries.get(key));
	}
}

/** Lists every ref (name → object id) so checkpoint refs can be compared. */
function listRefs(repoPath: string): Map<string, string> {
	const output = runGit(repoPath, ["for-each-ref", "--format=%(refname) %(objectname)"]);
	const refs = new Map<string, string>();
	if (output.length === 0) {
		return refs;
	}
	for (const line of output.split("\n")) {
		const [name, objectId] = line.split(" ");
		if (name && objectId) {
			refs.set(name, objectId);
		}
	}
	return refs;
}

function listBranches(repoPath: string): string {
	return runGit(repoPath, ["branch", "--list"]);
}

function readInfoExclude(repoPath: string): string {
	const excludePath = join(repoPath, ".git", "info", "exclude");
	return existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
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

async function waitForProcessStart(serverProcess: ChildProcess, timeoutMs = 10_000): Promise<string> {
	return await new Promise<string>((resolveStart, rejectStart) => {
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
			const match = stdout.match(/Kanban running at (http:\/\/127\.0\.0\.1:\d+(?:\/[^\s]*)?)/);
			if (!match || settled) {
				return;
			}
			const runtimeUrl = match[1];
			if (!runtimeUrl) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			resolveStart(runtimeUrl);
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

function getShutdownSignal(): NodeJS.Signals {
	return process.platform === "win32" ? "SIGTERM" : "SIGINT";
}

async function requestGracefulShutdown(childProcess: ChildProcess): Promise<void> {
	if (typeof childProcess.send !== "function" || !childProcess.connected) {
		childProcess.kill(getShutdownSignal());
		return;
	}
	await new Promise<void>((resolveSend) => {
		childProcess.send({ type: "kanban.shutdown" }, (error) => {
			if (error) {
				childProcess.kill(getShutdownSignal());
			}
			resolveSend();
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

interface RunningServer {
	runtimeUrl: string;
	workspaceId: string;
	baseUrl: string;
	stop: () => Promise<void>;
}

async function startKanbanServer(input: { cwd: string; homeDir: string; port: number }): Promise<RunningServer> {
	const cliEntrypoint = resolve(process.cwd(), "src/cli.ts");
	const child = spawn(
		process.execPath,
		[
			"--require",
			resolveShutdownIpcHookPath(),
			"--import",
			resolveTsxLoaderImportSpecifier(),
			cliEntrypoint,
			"--no-open",
		],
		{
			cwd: input.cwd,
			env: createGitTestEnv({
				HOME: input.homeDir,
				USERPROFILE: input.homeDir,
				KANBAN_RUNTIME_PORT: String(input.port),
			}),
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		},
	);
	const runtimeUrl = await waitForProcessStart(child, 60_000);
	const workspaceId = decodeURIComponent(new URL(runtimeUrl).pathname.slice(1));
	return {
		runtimeUrl,
		workspaceId,
		baseUrl: `http://127.0.0.1:${input.port}`,
		stop: async () => {
			if (child.exitCode !== null) {
				return;
			}
			await requestGracefulShutdown(child);
			const didExitGracefully = await waitForExit(child, 5_000);
			if (didExitGracefully) {
				return;
			}
			child.kill("SIGKILL");
			const didExitAfterForce = await waitForExit(child, 5_000);
			if (!didExitAfterForce) {
				throw new Error("Timed out stopping kanban test server process.");
			}
		},
	};
}

async function requestJson<T>(input: {
	baseUrl: string;
	procedure: string;
	type: "query" | "mutation";
	workspaceId?: string | null;
	payload?: unknown;
}): Promise<{ status: number; payload: T }> {
	const unwrapTrpcPayload = (value: unknown): unknown => {
		const envelope = Array.isArray(value) ? value[0] : value;
		if (!envelope || typeof envelope !== "object") {
			return value;
		}
		if ("result" in envelope) {
			const result = (envelope as { result?: { data?: unknown } }).result;
			const data = result?.data;
			if (data && typeof data === "object" && "json" in data) {
				return (data as { json: unknown }).json;
			}
			return data;
		}
		if ("error" in envelope) {
			return (envelope as { error: unknown }).error;
		}
		return value;
	};
	const headers = new Headers();
	if (input.workspaceId) {
		headers.set("x-kanban-workspace-id", input.workspaceId);
	}
	let url = `${input.baseUrl}/api/trpc/${input.procedure}`;
	let method: "GET" | "POST";
	let body: string | undefined;
	if (input.type === "query") {
		method = "GET";
		if (input.payload !== undefined) {
			url += `?input=${encodeURIComponent(JSON.stringify(input.payload))}`;
		}
	} else {
		method = "POST";
		body = input.payload === undefined ? undefined : JSON.stringify(input.payload);
	}
	if (body !== undefined) {
		headers.set("Content-Type", "application/json");
	}
	const response = await fetch(url, { method, headers, body });
	const payload = unwrapTrpcPayload(await response.json().catch(() => null)) as T;
	return { status: response.status, payload };
}

function createCard(id: string, baseRef: string): RuntimeBoardCard {
	const now = Date.now();
	return {
		id,
		title: id,
		prompt: `Prompt for ${id}`,
		startInPlanMode: false,
		baseRef,
		createdAt: now,
		updatedAt: now,
	};
}

function createBoardWithColumns(columns: {
	backlog?: RuntimeBoardCard[];
	inProgress?: RuntimeBoardCard[];
	review?: RuntimeBoardCard[];
	trash?: RuntimeBoardCard[];
}): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: columns.backlog ?? [] },
			{ id: "in_progress", title: "In Progress", cards: columns.inProgress ?? [] },
			{ id: "review", title: "Review", cards: columns.review ?? [] },
			{ id: "trash", title: "Done", cards: columns.trash ?? [] },
		],
		dependencies: [],
	};
}

async function saveBoard(
	server: RunningServer,
	board: RuntimeBoardData,
	sessions: RuntimeWorkspaceStateResponse["sessions"],
	expectedRevision: number,
): Promise<RuntimeWorkspaceStateResponse> {
	const response = await requestJson<RuntimeWorkspaceStateResponse>({
		baseUrl: server.baseUrl,
		procedure: "workspace.saveState",
		type: "mutation",
		workspaceId: server.workspaceId,
		payload: { board, sessions, expectedRevision },
	});
	expect(response.status).toBe(200);
	return response.payload;
}

describe.sequential("in-place mode filesystem guarantees integration", () => {
	it(
		"leaves the git project untouched across task start, review hook, trash, restore, and delete",
		{ timeout: 90_000 },
		async () => {
			const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-in-place-fs-");
			const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-in-place-fs-");

			initGitRepositoryWithCommit(projectPath);

			const worktreesDir = join(tempHome, ".cline", "worktrees");
			const kanbanStatePrefix = ".kanban";

			// Baseline snapshots before any runtime interaction.
			const projectBefore = snapshotPaths(projectPath, { excludePrefixes: [kanbanStatePrefix] });
			const refsBefore = listRefs(projectPath);
			const branchesBefore = listBranches(projectPath);
			const infoExcludeBefore = readInfoExclude(projectPath);
			const worktreesExistedBefore = existsSync(worktreesDir);

			const port = await getAvailablePort();
			const server = await startKanbanServer({ cwd: projectPath, homeDir: tempHome, port });

			try {
				const workspaceId = server.workspaceId;
				expect(workspaceId).not.toBe("");

				const taskId = "in-place-fs-task";
				const linkedTaskId = "in-place-fs-linked-task";
				const baseRef = runGit(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]);

				// Seed a board with the task in review plus a linked backlog task, so
				// trashing from review exercises the linked-task auto-start path (Req 4.4).
				const initialState = await requestJson<RuntimeWorkspaceStateResponse>({
					baseUrl: server.baseUrl,
					procedure: "workspace.getState",
					type: "query",
					workspaceId,
				});
				expect(initialState.status).toBe(200);

				const reviewBoard = createBoardWithColumns({
					review: [createCard(taskId, baseRef)],
					backlog: [createCard(linkedTaskId, baseRef)],
				});
				const afterSeed = await saveBoard(
					server,
					reviewBoard,
					initialState.payload.sessions,
					initialState.payload.revision,
				);

				// In-Place Mode: ensureWorktree is a no-op returning the project path.
				const ensureResponse = await requestJson<RuntimeWorktreeEnsureResponse>({
					baseUrl: server.baseUrl,
					procedure: "workspace.ensureWorktree",
					type: "mutation",
					workspaceId,
					payload: { taskId, baseRef },
				});
				expect(ensureResponse.status).toBe(200);
				expect(ensureResponse.payload.ok).toBe(true);
				if (!ensureResponse.payload.ok) {
					throw new Error(ensureResponse.payload.error ?? "ensureWorktree failed");
				}
				// Req 5.2: path is the project path, baseCommit is null, no worktree created.
				expect(ensureResponse.payload.path).toBe(projectPath);
				expect(ensureResponse.payload.baseCommit).toBeNull();

				// Req 3.3: a task shell session launches with the project path as its cwd.
				const shellResponse = await requestJson<RuntimeShellSessionStartResponse>({
					baseUrl: server.baseUrl,
					procedure: "runtime.startShellSession",
					type: "mutation",
					workspaceId,
					payload: { taskId, baseRef },
				});
				expect(shellResponse.status).toBe(200);
				expect(shellResponse.payload.ok).toBe(true);

				// Req 6.1/6.2/6.4: a to_review hook transition captures no checkpoint and
				// runs no git for checkpoint refs.
				const hookResponse = await requestJson<RuntimeHookIngestResponse>({
					baseUrl: server.baseUrl,
					procedure: "hooks.ingest",
					type: "mutation",
					payload: { taskId, workspaceId, event: "to_review" },
				});
				expect(hookResponse.status).toBe(200);
				expect(hookResponse.payload.ok).toBe(true);

				// Trash the task from the review column (Req 4.1): stop sessions, move to
				// trash, auto-start linked backlog task — all without touching the project.
				const stateBeforeTrash = await requestJson<RuntimeWorkspaceStateResponse>({
					baseUrl: server.baseUrl,
					procedure: "workspace.getState",
					type: "query",
					workspaceId,
				});
				const trashBoard = createBoardWithColumns({
					backlog: [createCard(linkedTaskId, baseRef)],
					trash: [createCard(taskId, baseRef)],
				});
				const afterTrash = await saveBoard(
					server,
					trashBoard,
					stateBeforeTrash.payload.sessions,
					stateBeforeTrash.payload.revision,
				);
				expect(afterTrash.revision).toBe(stateBeforeTrash.payload.revision + 1);

				// Restore the trashed task to review (Req 4.6): no worktree created, no
				// patch applied.
				const restoreBoard = createBoardWithColumns({
					backlog: [createCard(linkedTaskId, baseRef)],
					review: [createCard(taskId, baseRef)],
				});
				const afterRestore = await saveBoard(server, restoreBoard, afterTrash.sessions, afterTrash.revision);

				// Permanently delete the task (Req 4.2): removed from the board entirely,
				// again without touching the project filesystem.
				const deleteBoard = createBoardWithColumns({
					backlog: [createCard(linkedTaskId, baseRef)],
				});
				await saveBoard(server, deleteBoard, afterRestore.sessions, afterRestore.revision);
				void afterSeed;
			} finally {
				await server.stop();
			}

			// After all runtime operations: the project (outside .kanban) is
			// byte-for-byte identical, refs and branches are unchanged, .git/info/exclude
			// is untouched, and no checkpoint refs or worktrees were created.
			const projectAfter = snapshotPaths(projectPath, { excludePrefixes: [kanbanStatePrefix] });
			expectSnapshotsEqual(projectBefore, projectAfter);

			const refsAfter = listRefs(projectPath);
			expect([...refsAfter.entries()].sort()).toEqual([...refsBefore.entries()].sort());
			// Req 6.1/6.4: no checkpoint refs created or removed.
			const checkpointRefsAfter = [...refsAfter.keys()].filter((name) =>
				name.startsWith("refs/kanban/checkpoints/"),
			);
			expect(checkpointRefsAfter).toEqual([]);

			expect(listBranches(projectPath)).toBe(branchesBefore);
			expect(readInfoExclude(projectPath)).toBe(infoExcludeBefore);

			// Req 3.4: no worktree directory created under ~/.cline/worktrees.
			if (worktreesExistedBefore) {
				throw new Error("Expected ~/.cline/worktrees to be absent in the baseline.");
			}
			expect(existsSync(worktreesDir)).toBe(false);

			cleanupProject();
			cleanupHome();
		},
	);

	it("loads a non-git project board with no checkpoint or git errors", { timeout: 90_000 }, async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-in-place-non-git-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-in-place-non-git-");

		// A plain, non-git folder with some content.
		writeFileSync(join(projectPath, "notes.md"), "# notes\n", "utf8");
		mkdirSync(join(projectPath, "assets"), { recursive: true });
		writeFileSync(join(projectPath, "assets", "logo.svg"), "<svg/>\n", "utf8");

		const kanbanStatePrefix = ".kanban";
		const projectBefore = snapshotPaths(projectPath, { excludePrefixes: [kanbanStatePrefix] });

		const port = await getAvailablePort();
		const server = await startKanbanServer({ cwd: projectPath, homeDir: tempHome, port });

		try {
			const workspaceId = server.workspaceId;
			expect(workspaceId).not.toBe("");

			// Req 10.9: the board loads cleanly for a non-git project.
			const state = await requestJson<RuntimeWorkspaceStateResponse>({
				baseUrl: server.baseUrl,
				procedure: "workspace.getState",
				type: "query",
				workspaceId,
			});
			expect(state.status).toBe(200);
			expect(state.payload.board.columns.map((column) => column.id)).toEqual([
				"backlog",
				"in_progress",
				"review",
				"trash",
			]);

			const taskId = "non-git-task";

			// Req 5.8 + 5.2: a Worktree_Endpoint on a non-git folder returns a
			// well-formed success response with the project path and null baseCommit.
			const ensureResponse = await requestJson<RuntimeWorktreeEnsureResponse>({
				baseUrl: server.baseUrl,
				procedure: "workspace.ensureWorktree",
				type: "mutation",
				workspaceId,
				payload: { taskId, baseRef: "" },
			});
			expect(ensureResponse.status).toBe(200);
			expect(ensureResponse.payload.ok).toBe(true);
			if (!ensureResponse.payload.ok) {
				throw new Error(ensureResponse.payload.error ?? "ensureWorktree failed");
			}
			expect(ensureResponse.payload.path).toBe(projectPath);
			expect(ensureResponse.payload.baseCommit).toBeNull();

			// Req 5.8 + 5.5: a Diff_Endpoint returns an empty, well-formed response.
			const changesResponse = await requestJson<RuntimeWorkspaceChangesResponse>({
				baseUrl: server.baseUrl,
				procedure: "workspace.getChanges",
				type: "query",
				workspaceId,
				payload: { taskId, baseRef: "" },
			});
			expect(changesResponse.status).toBe(200);
			expect(changesResponse.payload.repoRoot).toBe(projectPath);
			expect(changesResponse.payload.files).toEqual([]);

			// Req 5.8 + 5.6: a Git_Endpoint returns ok:true with no error.
			const gitSummaryResponse = await requestJson<RuntimeGitSummaryResponse>({
				baseUrl: server.baseUrl,
				procedure: "workspace.getGitSummary",
				type: "query",
				workspaceId,
			});
			expect(gitSummaryResponse.status).toBe(200);
			expect(gitSummaryResponse.payload.ok).toBe(true);
			expect(gitSummaryResponse.payload.error).toBeUndefined();

			// Req 6.5: a to_review hook on a non-git project reports no checkpoint error.
			const reviewBoard = createBoardWithColumns({ review: [createCard(taskId, "")] });
			const seeded = await saveBoard(server, reviewBoard, state.payload.sessions, state.payload.revision);
			void seeded;
			// Establish a session summary so the hook has a task to act on; the in-place
			// shell cwd is the project path itself.
			const shellResponse = await requestJson<RuntimeShellSessionStartResponse>({
				baseUrl: server.baseUrl,
				procedure: "runtime.startShellSession",
				type: "mutation",
				workspaceId,
				payload: { taskId, baseRef: "" },
			});
			expect(shellResponse.status).toBe(200);
			expect(shellResponse.payload.ok).toBe(true);
			const hookResponse = await requestJson<RuntimeHookIngestResponse>({
				baseUrl: server.baseUrl,
				procedure: "hooks.ingest",
				type: "mutation",
				payload: { taskId, workspaceId, event: "to_review" },
			});
			expect(hookResponse.status).toBe(200);
			expect(hookResponse.payload.ok).toBe(true);
		} finally {
			await server.stop();
		}

		// The runtime initialized no git repository and touched nothing outside
		// .kanban (Req 10.4 / 14.2).
		expect(existsSync(join(projectPath, ".git"))).toBe(false);
		const projectAfter = snapshotPaths(projectPath, { excludePrefixes: [kanbanStatePrefix] });
		expectSnapshotsEqual(projectBefore, projectAfter);

		cleanupProject();
		cleanupHome();
	});
});
