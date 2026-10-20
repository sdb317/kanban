/**
 * Integration coverage for the workspaces-index-lock-crash bugfix.
 *
 * Drives real task-operation flows (`loadWorkspaceContext`,
 * `removeWorkspaceIndexEntry`, `removeWorkspaceStateFiles`) against a real
 * temporary HOME and real proper-lockfile lock files. The proper-lockfile
 * module is wrapped (not replaced): the real `lock` acquires/releases on disk,
 * and the wrapper deterministically injects synthetic ECOMPROMISED errors into
 * the `onCompromised` handler that `LockedFileSystem` passed in:
 *
 * - after release, from a timer callback (mirrors the refresh timer firing on a
 *   lock file our own release already removed), and
 * - right after acquisition, inside the critical section (genuine compromise).
 *
 * Process-level `uncaughtException` / `unhandledRejection` listeners verify no
 * error escapes, which is what crashed the app before the fix.
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4**
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getSystemErrorMap } from "node:util";

import type * as ProperLockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lockedFileSystem } from "../../src/fs/locked-file-system";
import {
	getWorkspacesRootPath,
	listWorkspaceIndexEntries,
	loadWorkspaceContext,
	removeWorkspaceIndexEntry,
	removeWorkspaceStateFiles,
} from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

type CompromiseInjector = (lockfilePath: string) => Error | null;

interface LockEvent {
	kind: "acquire" | "release";
	lockfilePath: string;
}

interface HandlerOutcome {
	lockfilePath: string;
	error: Error;
	threw: unknown;
}

const lockHarness = vi.hoisted(() => ({
	events: [] as LockEvent[],
	handlerOutcomes: [] as HandlerOutcome[],
	afterRelease: null as CompromiseInjector | null,
	onAcquire: null as CompromiseInjector | null,
	/** proper-lockfile's library default handler: `(err) => { throw err; }`. */
	libraryDefaultOnCompromised(error: Error): void {
		throw error;
	},
}));

vi.mock("proper-lockfile", async (importOriginal) => {
	const actual = await importOriginal<typeof ProperLockfile>();
	const lock: typeof actual.lock = async (file, options) => {
		const release = await actual.lock(file, options);
		const lockfilePath = options?.lockfilePath ?? `${file}.lock`;
		const onCompromised = options?.onCompromised ?? lockHarness.libraryDefaultOnCompromised;
		lockHarness.events.push({ kind: "acquire", lockfilePath });

		// Genuine compromise while the critical section is live. proper-lockfile
		// drops a compromised lock, so release the real lock before surfacing.
		const liveError = lockHarness.onAcquire?.(lockfilePath) ?? null;
		if (liveError) {
			try {
				onCompromised(liveError);
				lockHarness.handlerOutcomes.push({ lockfilePath, error: liveError, threw: undefined });
			} catch (thrown) {
				lockHarness.handlerOutcomes.push({ lockfilePath, error: liveError, threw: thrown });
				await release();
				throw thrown;
			}
		}

		return async () => {
			await release();
			lockHarness.events.push({ kind: "release", lockfilePath });
			const raceError = lockHarness.afterRelease?.(lockfilePath) ?? null;
			if (!raceError) {
				return;
			}
			// Trailing refresh callback fires from a timer after the lock file is
			// gone. A throw here is uncaught, exactly like the production crash.
			setTimeout(() => {
				try {
					onCompromised(raceError);
					lockHarness.handlerOutcomes.push({ lockfilePath, error: raceError, threw: undefined });
				} catch (thrown) {
					lockHarness.handlerOutcomes.push({ lockfilePath, error: raceError, threw: thrown });
					throw thrown;
				}
			}, 0);
		};
	};
	return { ...actual, lock };
});

const ENOENT_ERRNO = [...getSystemErrorMap().entries()].find(([, [name]]) => name === "ENOENT")?.[0] ?? -2;

/**
 * Mirrors proper-lockfile's release-race error: the original ENOENT syscall
 * error with `code` reassigned to ECOMPROMISED (syscall/errno/path preserved).
 */
function createReleaseRaceCompromise(syscall: "utime" | "utimes" | "stat", lockfilePath: string): Error {
	return Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${lockfilePath}'`), {
		errno: ENOENT_ERRNO,
		code: "ECOMPROMISED",
		syscall,
		path: lockfilePath,
	});
}

function createGenuineCompromise(): Error {
	return Object.assign(new Error("Unable to update lock within the stale threshold"), {
		code: "ECOMPROMISED",
	});
}

function isIndexLock(lockfilePath: string): boolean {
	return lockfilePath === join(getWorkspacesRootPath(), "index.json.lock");
}

function readIndexFile(): { entries: Record<string, { repoPath: string }>; repoPathToId: Record<string, string> } {
	return JSON.parse(readFileSync(join(getWorkspacesRootPath(), "index.json"), "utf8"));
}

async function flushTimers(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 25));
}

function initGitRepository(path: string): void {
	mkdirSync(path, { recursive: true });
	const init = spawnSync("git", ["init"], { cwd: path, stdio: "ignore", env: createGitTestEnv() });
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
}

async function withTemporaryHome<T>(run: (sandboxRoot: string) => Promise<T>): Promise<T> {
	const home = createTempDir("kanban-lock-race-home-");
	const sandbox = createTempDir("kanban-lock-race-repos-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = home.path;
	process.env.USERPROFILE = home.path;
	try {
		return await run(sandbox.path);
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		sandbox.cleanup();
		home.cleanup();
	}
}

describe.sequential("workspace index lock release-race integration", () => {
	const escapedErrors: unknown[] = [];
	const recordEscapedError = (error: unknown) => {
		escapedErrors.push(error);
	};

	beforeEach(() => {
		escapedErrors.length = 0;
		lockHarness.events.length = 0;
		lockHarness.handlerOutcomes.length = 0;
		lockHarness.afterRelease = null;
		lockHarness.onAcquire = null;
		process.on("uncaughtException", recordEscapedError);
		process.on("unhandledRejection", recordEscapedError);
	});

	afterEach(() => {
		process.off("uncaughtException", recordEscapedError);
		process.off("unhandledRejection", recordEscapedError);
		lockHarness.afterRelease = null;
		lockHarness.onAcquire = null;
	});

	it("completes loadWorkspaceContext / removeWorkspaceIndexEntry when the refresh races release", async () => {
		await withTemporaryHome(async (sandboxRoot) => {
			const alphaPath = join(sandboxRoot, "alpha");
			const betaPath = join(sandboxRoot, "beta");
			initGitRepository(alphaPath);
			initGitRepository(betaPath);
			lockHarness.afterRelease = (lockfilePath) =>
				isIndexLock(lockfilePath) ? createReleaseRaceCompromise("utime", lockfilePath) : null;

			const alpha = await loadWorkspaceContext(alphaPath);
			const beta = await loadWorkspaceContext(betaPath);
			expect(await removeWorkspaceIndexEntry(alpha.workspaceId)).toBe(true);
			await flushTimers();

			// The injected compromise really reached the installed handler, once per
			// index-lock release, and was tolerated every time.
			const indexReleases = lockHarness.events.filter(
				(event) => event.kind === "release" && isIndexLock(event.lockfilePath),
			);
			expect(indexReleases).toHaveLength(3);
			expect(lockHarness.handlerOutcomes).toHaveLength(3);
			expect(lockHarness.handlerOutcomes.every((outcome) => outcome.threw === undefined)).toBe(true);
			expect(escapedErrors).toEqual([]);

			// Critical-section results stand: index.json reflects both operations.
			const index = readIndexFile();
			expect(Object.keys(index.entries)).toEqual([beta.workspaceId]);
			expect(Object.values(index.repoPathToId)).toEqual([beta.workspaceId]);
			expect(existsSync(join(getWorkspacesRootPath(), "index.json.lock"))).toBe(false);
		});
	});

	it("survives rapid sequential index-locked operations with trailing refresh callbacks", async () => {
		await withTemporaryHome(async (sandboxRoot) => {
			const repoPaths = ["one", "two", "three", "four"].map((name) => join(sandboxRoot, name));
			for (const repoPath of repoPaths) {
				initGitRepository(repoPath);
			}
			const syscalls = ["utime", "stat", "utimes"] as const;
			let injected = 0;
			lockHarness.afterRelease = (lockfilePath) => {
				if (!isIndexLock(lockfilePath)) {
					return null;
				}
				const syscall = syscalls[injected % syscalls.length] ?? "utime";
				injected += 1;
				return createReleaseRaceCompromise(syscall, lockfilePath);
			};

			const contexts = [];
			for (const repoPath of repoPaths) {
				contexts.push(await loadWorkspaceContext(repoPath));
			}
			const [first, second, third, fourth] = contexts;
			if (!first || !second || !third || !fourth) {
				throw new Error("Expected four workspace contexts.");
			}
			expect(await removeWorkspaceIndexEntry(first.workspaceId)).toBe(true);
			expect(await removeWorkspaceIndexEntry(third.workspaceId)).toBe(true);
			expect(await removeWorkspaceIndexEntry(third.workspaceId)).toBe(false);
			// Re-adding an existing repo reuses its id.
			expect((await loadWorkspaceContext(repoPaths[1] ?? "")).workspaceId).toBe(second.workspaceId);
			await flushTimers();

			expect(injected).toBe(8);
			expect(lockHarness.handlerOutcomes).toHaveLength(8);
			expect(lockHarness.handlerOutcomes.every((outcome) => outcome.threw === undefined)).toBe(true);
			expect(escapedErrors).toEqual([]);

			const entries = await listWorkspaceIndexEntries();
			expect(entries.map((entry) => entry.workspaceId).sort()).toEqual(
				[second.workspaceId, fourth.workspaceId].sort(),
			);
			expect(Object.keys(readIndexFile().entries).sort()).toEqual([second.workspaceId, fourth.workspaceId].sort());
		});
	});

	it("surfaces a genuine compromise injected mid-critical-section to the caller", async () => {
		await withTemporaryHome(async (sandboxRoot) => {
			const alphaPath = join(sandboxRoot, "alpha");
			const betaPath = join(sandboxRoot, "beta");
			initGitRepository(alphaPath);
			initGitRepository(betaPath);
			const alpha = await loadWorkspaceContext(alphaPath);
			const indexBefore = readFileSync(join(getWorkspacesRootPath(), "index.json"), "utf8");

			const genuine = createGenuineCompromise();
			lockHarness.onAcquire = (lockfilePath) => (isIndexLock(lockfilePath) ? genuine : null);

			await expect(loadWorkspaceContext(betaPath)).rejects.toBe(genuine);
			await expect(removeWorkspaceIndexEntry(alpha.workspaceId)).rejects.toBe(genuine);
			expect(lockHarness.handlerOutcomes.map((outcome) => outcome.threw)).toEqual([genuine, genuine]);

			// Aborted critical sections left the index untouched and the lock free.
			expect(readFileSync(join(getWorkspacesRootPath(), "index.json"), "utf8")).toBe(indexBefore);
			expect(existsSync(join(getWorkspacesRootPath(), "index.json.lock"))).toBe(false);

			lockHarness.onAcquire = null;
			const beta = await loadWorkspaceContext(betaPath);
			expect(Object.keys(readIndexFile().entries).sort()).toEqual([alpha.workspaceId, beta.workspaceId].sort());
			await flushTimers();
			expect(escapedErrors).toEqual([]);
		});
	});

	it("acquires multi-locks in sorted order and releases them in reverse order", async () => {
		await withTemporaryHome(async (sandboxRoot) => {
			const alphaPath = join(sandboxRoot, "alpha");
			initGitRepository(alphaPath);
			const alpha = await loadWorkspaceContext(alphaPath);
			// Release-race compromises on every lock must not disturb ordering.
			lockHarness.afterRelease = (lockfilePath) => createReleaseRaceCompromise("utime", lockfilePath);
			lockHarness.events.length = 0;

			await removeWorkspaceStateFiles(alpha.workspaceId);

			const rootLock = join(getWorkspacesRootPath(), ".workspaces.lock");
			const directoryLock = join(getWorkspacesRootPath(), `${alpha.workspaceId}.lock`);
			const sorted = [rootLock, directoryLock].sort((left, right) => left.localeCompare(right));
			expect(lockHarness.events).toEqual([
				...sorted.map((lockfilePath) => ({ kind: "acquire", lockfilePath })),
				...sorted.reverse().map((lockfilePath) => ({ kind: "release", lockfilePath })),
			]);

			lockHarness.events.length = 0;
			const filesRoot = join(sandboxRoot, "files");
			const unsortedPaths = ["c.json", "a.json", "b.json"].map((name) => join(filesRoot, name));
			const result = await lockedFileSystem.withLocks(
				unsortedPaths.map((path) => ({ path, type: "file" as const })),
				async () => "done",
			);
			expect(result).toBe("done");
			const expectedOrder = unsortedPaths
				.map((path) => `${path}.lock`)
				.sort((left, right) => left.localeCompare(right));
			expect(lockHarness.events).toEqual([
				...expectedOrder.map((lockfilePath) => ({ kind: "acquire", lockfilePath })),
				...expectedOrder.reverse().map((lockfilePath) => ({ kind: "release", lockfilePath })),
			]);

			await flushTimers();
			expect(lockHarness.handlerOutcomes).toHaveLength(5);
			expect(lockHarness.handlerOutcomes.every((outcome) => outcome.threw === undefined)).toBe(true);
			expect(escapedErrors).toEqual([]);
		});
	});
});
