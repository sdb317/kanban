import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTempDir } from "../utilities/temp-dir";

const lockfileMocks = vi.hoisted(() => ({
	lock: vi.fn(),
	release: vi.fn(async () => {}),
}));

vi.mock("proper-lockfile", () => ({
	lock: lockfileMocks.lock,
}));

import { LockedFileSystem } from "../../src/fs/locked-file-system";

/**
 * proper-lockfile's library default handler: `(err) => { throw err; }`.
 * The real `setLockAsCompromised` invokes `lock.options.onCompromised(err)`,
 * and `lock()` fills in this throwing default when the caller supplies none.
 */
function properLockfileDefaultOnCompromised(error: unknown): void {
	throw error;
}

/**
 * Build an error that mirrors the shape proper-lockfile produces for the
 * refresh/release race: the original ENOENT syscall error from `fs.stat` /
 * `fs.utimes` with `code` reassigned to "ECOMPROMISED" while the original
 * syscall metadata (syscall/errno/message/path) is preserved. See
 * `updateLock` -> `setLockAsCompromised` in proper-lockfile/lib/lockfile.js.
 */
interface ReleaseRaceCompromiseError extends Error {
	errno: number;
	code: string;
	syscall: string;
	path: string;
	underlyingCode: string;
}

function createReleaseRaceCompromise(
	syscall: "utime" | "utimes" | "stat",
	lockfilePath: string,
): ReleaseRaceCompromiseError {
	const underlying = Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${lockfilePath}'`), {
		errno: -4058,
		code: "ENOENT",
		syscall,
		path: lockfilePath,
		// The handler inspects an underlying ENOENT marker to distinguish a
		// benign release-race compromise from a genuine one.
		underlyingCode: "ENOENT",
	});
	// proper-lockfile reassigns `code` to ECOMPROMISED on the SAME error object,
	// so `syscall`/`errno`/`path` and the ENOENT message survive.
	return Object.assign(underlying, { code: "ECOMPROMISED" });
}

describe("LockedFileSystem", () => {
	beforeEach(() => {
		lockfileMocks.release.mockReset();
		lockfileMocks.release.mockResolvedValue(undefined);
		lockfileMocks.lock.mockReset();
		lockfileMocks.lock.mockResolvedValue(lockfileMocks.release);
	});

	it("installs a default onCompromised when no handler is provided", async () => {
		const tempDir = createTempDir("kanban-locked-fs-");
		try {
			const filePath = join(tempDir.path, "state.json");
			const lockedFileSystem = new LockedFileSystem();

			await lockedFileSystem.withLock({ path: filePath, type: "file" }, async () => {});

			expect(lockfileMocks.lock).toHaveBeenCalledTimes(1);
			const options = lockfileMocks.lock.mock.calls[0]?.[1] as Record<string, unknown>;
			expect(typeof options.onCompromised).toBe("function");
			expect(lockfileMocks.release).toHaveBeenCalledTimes(1);
		} finally {
			tempDir.cleanup();
		}
	});

	it("forwards onCompromised when a handler is provided", async () => {
		const tempDir = createTempDir("kanban-locked-fs-");
		try {
			const filePath = join(tempDir.path, "state.json");
			const lockedFileSystem = new LockedFileSystem();
			const onCompromised = vi.fn();

			await lockedFileSystem.withLock({ path: filePath, type: "file", onCompromised }, async () => {});

			const options = lockfileMocks.lock.mock.calls[0]?.[1] as Record<string, unknown>;
			expect(options.onCompromised).toBe(onCompromised);
		} finally {
			tempDir.cleanup();
		}
	});
});

/**
 * Bug condition exploration test (Property 1: Bug Condition).
 *
 * Bugfix spec: workspaces-index-lock-crash.
 *
 * isBugCondition(input):
 *   error.code == "ECOMPROMISED"
 *   AND error.syscall IN ["utime", "utimes", "stat"]
 *   AND error.underlyingCode == "ENOENT"
 *   AND criticalSectionCompleted == true
 *   AND NOT handledByOnCompromised
 *
 * Expected Behavior (asserted here) on FIXED code: the release-race compromise
 * is tolerated — no unhandled error, the process keeps running, and the
 * critical-section result is preserved.
 *
 * On UNFIXED code this test is EXPECTED TO FAIL: `createLockOptions` installs no
 * default `onCompromised`, so the mock applies proper-lockfile's throwing
 * default and the injected ECOMPROMISED/ENOENT error escapes `withLock`.
 *
 * Determinism: rather than racing a wall-clock refresh timer, we drive the
 * compromise synthetically through the stubbed `proper-lockfile`. The mocked
 * `lock` records the `onCompromised` from the options proper-lockfile would
 * resolve (`request.onCompromised ?? libraryThrowingDefault`) and fires it
 * AFTER the critical section's operation has resolved and the lock released —
 * exactly the refresh-timer-after-release window.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3**
 */
describe("LockedFileSystem bug condition: release-race compromised lock", () => {
	beforeEach(() => {
		lockfileMocks.release.mockReset();
		lockfileMocks.release.mockResolvedValue(undefined);
		lockfileMocks.lock.mockReset();
	});

	/**
	 * Install a mock `lock` that, after the operation resolves, simulates the
	 * refresh timer firing against the already-removed lock file: it invokes the
	 * resolved `onCompromised` handler with a release-race ECOMPROMISED/ENOENT
	 * error. Any error the handler throws is surfaced as an unhandled rejection,
	 * captured here so the test can assert whether the locking layer crashed.
	 */
	function installReleaseRaceLock(error: Error): { getUnhandled: () => unknown } {
		let unhandled: unknown;
		lockfileMocks.lock.mockImplementation(async (_file: string, options: Record<string, unknown>) => {
			const onCompromised =
				typeof options?.onCompromised === "function"
					? (options.onCompromised as (err: unknown) => void)
					: properLockfileDefaultOnCompromised;
			return async () => {
				// Lock release completes first (critical section already done)...
				await lockfileMocks.release();
				// ...then the trailing refresh callback fires on the removed lock file.
				try {
					onCompromised(error);
				} catch (thrown) {
					// proper-lockfile fires onCompromised from a timer callback, so a
					// throw here becomes an unhandled rejection rather than something
					// `withLock`'s await can catch. Model that escape.
					unhandled = thrown;
				}
			};
		});
		return { getUnhandled: () => unhandled };
	}

	interface ReleaseRaceCase {
		readonly name: string;
		readonly syscall: "utime" | "utimes" | "stat";
		buildRequest(tempDir: string): {
			readonly request: Parameters<LockedFileSystem["withLock"]>[0];
			readonly lockfilePath: string;
		};
	}

	// Scoped PBT input space: concrete release-race signatures across the
	// relevant syscalls and lock kinds. Each case is a point in the domain
	// { syscall in [utime, utimes, stat] } x { index file lock, directory lock }.
	const releaseRaceCases: readonly ReleaseRaceCase[] = [
		{
			name: "index lock release-race (utime)",
			syscall: "utime",
			buildRequest(tempDir) {
				const indexPath = join(tempDir, "workspaces", "index.json");
				return {
					request: { path: indexPath, type: "file" },
					lockfilePath: `${indexPath}.lock`,
				};
			},
		},
		{
			name: "index lock release-race (stat)",
			syscall: "stat",
			buildRequest(tempDir) {
				const indexPath = join(tempDir, "workspaces", "index.json");
				return {
					request: { path: indexPath, type: "file" },
					lockfilePath: `${indexPath}.lock`,
				};
			},
		},
		{
			name: "directory/root lock release-race (utimes)",
			syscall: "utimes",
			buildRequest(tempDir) {
				const dirPath = join(tempDir, "workspaces");
				const lockfilePath = join(dirPath, ".lock");
				return {
					request: { path: dirPath, type: "directory" },
					lockfilePath,
				};
			},
		},
	];

	for (const testCase of releaseRaceCases) {
		it(`tolerates ${testCase.name} without crashing`, async () => {
			const tempDir = createTempDir("kanban-locked-fs-race-");
			try {
				const { request, lockfilePath } = testCase.buildRequest(tempDir.path);
				const compromise = createReleaseRaceCompromise(testCase.syscall, lockfilePath);

				// Precondition: this is genuinely the bug condition.
				expect(compromise.code).toBe("ECOMPROMISED");
				expect(["utime", "utimes", "stat"]).toContain((compromise as unknown as { syscall: string }).syscall);
				expect((compromise as unknown as { underlyingCode: string }).underlyingCode).toBe("ENOENT");

				const { getUnhandled } = installReleaseRaceLock(compromise);
				const lockedFileSystem = new LockedFileSystem();

				const CRITICAL_SECTION_RESULT = Symbol("critical-section-result");
				let operationRan = false;

				// Expected Behavior: no unhandled error escapes the locking layer...
				const result = await lockedFileSystem.withLock(request, async () => {
					operationRan = true;
					return CRITICAL_SECTION_RESULT;
				});

				// ...the critical section ran and its result is preserved...
				expect(operationRan).toBe(true);
				expect(result).toBe(CRITICAL_SECTION_RESULT);

				// ...and the trailing release-race compromise did NOT escape as an
				// unhandled error (the process keeps running). On UNFIXED code this
				// assertion fails because the library default rethrows the error.
				expect(getUnhandled()).toBeUndefined();
			} finally {
				tempDir.cleanup();
			}
		});
	}

	it("still surfaces a genuine (non-ENOENT) compromise while the critical section is live", async () => {
		const tempDir = createTempDir("kanban-locked-fs-race-");
		try {
			const indexPath = join(tempDir.path, "workspaces", "index.json");
			// Genuine compromise: mtime stolen, NOT an ENOENT release race.
			const genuine = Object.assign(new Error("Unable to update lock within the stale threshold"), {
				code: "ECOMPROMISED",
			});

			const { getUnhandled } = installReleaseRaceLock(genuine);
			const lockedFileSystem = new LockedFileSystem();

			await lockedFileSystem.withLock({ path: indexPath, type: "file" }, async () => {});

			// A genuine compromise must continue to surface (not be swallowed) on
			// both unfixed and fixed code.
			expect(getUnhandled()).toBe(genuine);
		} finally {
			tempDir.cleanup();
		}
	});
});

/**
 * Preservation property tests (Property 2: Preservation).
 *
 * Bugfix spec: workspaces-index-lock-crash.
 *
 * These tests capture the baseline behavior the fix (task 3) MUST NOT change.
 * Following the observation-first methodology, every assertion here records the
 * ACTUAL behavior of the UNFIXED code and therefore PASSES on the current
 * (unfixed) implementation. They must keep passing after task 3.1 installs the
 * default `onCompromised` handler.
 *
 * Preservation focuses only on behaviors that genuinely must survive the fix:
 *   1. Successful acquire/release — operation runs, index.json persisted
 *      byte-for-byte identical (the common case: `onCompromised` never fires).
 *   2. Mutual exclusion — serialized access under contention; retries/stale
 *      from DEFAULT_LOCK_RETRIES / DEFAULT_LOCK_STALE_MS unchanged.
 *   3. Genuine compromise surfacing — a non-ENOENT ECOMPROMISED still surfaces.
 *   4. Request-supplied `onCompromised` precedence — a caller handler wins.
 *
 * NOTE: The existing case "omits onCompromised when no handler is provided"
 * asserts PRE-FIX behavior (no default handler installed) that task 3.1 will
 * intentionally change. It is a baseline, NOT a regression, and is updated by
 * task 3.1 — not here. The preservation tests below deliberately do NOT depend
 * on the absence of a default handler; they assert behaviors (byte-identical
 * persistence, mutual exclusion, genuine-compromise surfacing, request-handler
 * precedence) that remain true once a default handler exists.
 *
 * No property-based-testing library is available in this repo (no `fast-check`
 * in package.json), so we use thorough table-driven cases plus a locally
 * seeded, deterministic generator for the random `(sequence, operation)`
 * combinations the design's Preservation Checking calls for.
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
 */

/**
 * Tiny deterministic PRNG (mulberry32) so the "random" sequences are
 * reproducible across runs — no external dependency, no flakiness.
 */
function createSeededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state |= 0;
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("LockedFileSystem preservation: non-release-race behavior unchanged", () => {
	beforeEach(() => {
		lockfileMocks.release.mockReset();
		lockfileMocks.release.mockResolvedValue(undefined);
		lockfileMocks.lock.mockReset();
		lockfileMocks.lock.mockResolvedValue(lockfileMocks.release);
	});

	// --- Preservation 1: Successful acquire/release preservation ----------------
	//
	// Random successful lock/operation sequences: writeJsonFileAtomic acquires the
	// index lock, runs the write, releases. With no compromise signal the common
	// path is exercised and index.json must persist byte-for-byte identically.
	it("runs the operation and persists index.json byte-for-byte across random successful sequences", async () => {
		const random = createSeededRandom(0x5eed_1234);

		for (let iteration = 0; iteration < 25; iteration += 1) {
			const tempDir = createTempDir("kanban-locked-fs-preserve-");
			try {
				const indexPath = join(tempDir.path, "workspaces", "index.json");
				const lockedFileSystem = new LockedFileSystem();

				// Random but reproducible index payload.
				const entryCount = Math.floor(random() * 5);
				const payload = {
					version: Math.floor(random() * 10),
					workspaces: Array.from({ length: entryCount }, (_unused, index) => ({
						id: `ws-${Math.floor(random() * 1_000_000).toString(16)}`,
						order: index,
					})),
				};

				await lockedFileSystem.writeJsonFileAtomic(indexPath, payload);

				// Lock was acquired and released exactly once (operation ran under lock).
				expect(lockfileMocks.lock).toHaveBeenCalledTimes(1);
				expect(lockfileMocks.release).toHaveBeenCalledTimes(1);

				// Persistence is byte-for-byte identical to writeJsonFileAtomic's
				// serialization (JSON.stringify(payload, null, 2)).
				const persisted = readFileSync(indexPath, "utf8");
				expect(persisted).toBe(JSON.stringify(payload, null, 2));

				lockfileMocks.lock.mockClear();
				lockfileMocks.release.mockClear();
			} finally {
				tempDir.cleanup();
			}
		}
	});

	it("does not invoke onCompromised at all on the plain happy path (handler never fires)", async () => {
		const tempDir = createTempDir("kanban-locked-fs-preserve-");
		try {
			const filePath = join(tempDir.path, "state.json");
			const lockedFileSystem = new LockedFileSystem();

			// Capture whatever onCompromised the options would carry, if any, and
			// assert it is never called when there is no compromise event.
			let resolvedHandler: ((err: unknown) => void) | undefined;
			let handlerCalls = 0;
			lockfileMocks.lock.mockImplementation(async (_file: string, options: Record<string, unknown>) => {
				if (typeof options?.onCompromised === "function") {
					const original = options.onCompromised as (err: unknown) => void;
					resolvedHandler = (err) => {
						handlerCalls += 1;
						original(err);
					};
				}
				return lockfileMocks.release;
			});

			await lockedFileSystem.withLock({ path: filePath, type: "file" }, async () => {});

			expect(lockfileMocks.lock).toHaveBeenCalledTimes(1);
			expect(lockfileMocks.release).toHaveBeenCalledTimes(1);
			// Whether or not a default handler is installed, it must not fire when
			// no compromise occurs. (resolvedHandler may be undefined pre-fix.)
			void resolvedHandler;
			expect(handlerCalls).toBe(0);
		} finally {
			tempDir.cleanup();
		}
	});

	// --- Preservation 2: Mutual exclusion preservation --------------------------
	//
	// Under contention the lock serializes access: only one holder at a time. We
	// model proper-lockfile's guarantee by letting the mock `lock` admit a single
	// holder and reject concurrent acquisition, then assert withLock never allows
	// two operations into the critical section simultaneously. Also asserts the
	// stale/retries options passed to proper-lockfile are the documented defaults.
	it("serializes access under contention so only one holder is in the critical section at a time", async () => {
		const tempDir = createTempDir("kanban-locked-fs-preserve-");
		try {
			const indexPath = join(tempDir.path, "workspaces", "index.json");
			const lockedFileSystem = new LockedFileSystem();

			let heldCount = 0;
			let maxHeldConcurrently = 0;
			const releaseOf = () => async () => {
				heldCount -= 1;
			};
			// Serialize acquisition the way proper-lockfile would: callers queue
			// until the current holder releases.
			let acquisitionChain: Promise<void> = Promise.resolve();
			lockfileMocks.lock.mockImplementation(async () => {
				const previous = acquisitionChain;
				let unblock: () => void = () => {};
				acquisitionChain = new Promise<void>((resolve) => {
					unblock = resolve;
				});
				await previous;
				heldCount += 1;
				maxHeldConcurrently = Math.max(maxHeldConcurrently, heldCount);
				const release = releaseOf();
				return async () => {
					await release();
					unblock();
				};
			});

			const observations: number[] = [];
			const runOperation = async () =>
				await lockedFileSystem.withLock({ path: indexPath, type: "file" }, async () => {
					observations.push(heldCount);
					// Yield so a second operation could interleave if mutual exclusion
					// were broken.
					await Promise.resolve();
					await Promise.resolve();
				});

			await Promise.all([runOperation(), runOperation(), runOperation()]);

			// Only ever one holder inside the critical section.
			expect(maxHeldConcurrently).toBe(1);
			expect(observations).toEqual([1, 1, 1]);
			expect(lockfileMocks.lock).toHaveBeenCalledTimes(3);
		} finally {
			tempDir.cleanup();
		}
	});

	it("passes the unchanged DEFAULT_LOCK_STALE_MS / DEFAULT_LOCK_RETRIES options to proper-lockfile", async () => {
		const tempDir = createTempDir("kanban-locked-fs-preserve-");
		try {
			const indexPath = join(tempDir.path, "workspaces", "index.json");
			const lockedFileSystem = new LockedFileSystem();

			await lockedFileSystem.withLock({ path: indexPath, type: "file" }, async () => {});

			const options = lockfileMocks.lock.mock.calls[0]?.[1] as Record<string, unknown>;
			// Observed baseline defaults — these must remain unchanged by the fix.
			expect(options.stale).toBe(10_000);
			expect(options.retries).toEqual({
				retries: 200,
				factor: 1,
				minTimeout: 25,
				maxTimeout: 50,
				randomize: false,
			});
			expect(options.realpath).toBe(false);
			expect(typeof options.lockfilePath).toBe("string");
			expect(options.lockfilePath).toBe(`${indexPath}.lock`);
		} finally {
			tempDir.cleanup();
		}
	});

	// --- Preservation 3: Genuine compromise surfacing preservation --------------
	//
	// A compromise that is NOT a benign release-race ENOENT must continue to
	// surface (the throwing handler is invoked / the error escapes). We generalize
	// the single existing "genuine compromise" case across several non-ENOENT
	// compromise shapes to show none of them are swallowed on the unfixed code.
	interface GenuineCompromiseCase {
		readonly name: string;
		build(): Error;
	}

	const genuineCompromiseCases: readonly GenuineCompromiseCase[] = [
		{
			name: "stale-threshold overrun (mtime stolen)",
			build: () =>
				Object.assign(new Error("Unable to update lock within the stale threshold"), {
					code: "ECOMPROMISED",
				}),
		},
		{
			name: "mtime mismatch compromise",
			build: () =>
				Object.assign(new Error("Lock mtime has been modified since acquisition"), {
					code: "ECOMPROMISED",
				}),
		},
		{
			name: "non-ENOENT syscall failure (EACCES utime)",
			build: () =>
				Object.assign(new Error("EACCES: permission denied, utime 'index.json.lock'"), {
					code: "ECOMPROMISED",
					errno: -4092,
					syscall: "utime",
				}),
		},
	];

	for (const testCase of genuineCompromiseCases) {
		it(`surfaces a genuine compromise (${testCase.name}) rather than swallowing it`, async () => {
			const tempDir = createTempDir("kanban-locked-fs-preserve-");
			try {
				const indexPath = join(tempDir.path, "workspaces", "index.json");
				const genuine = testCase.build();

				let unhandled: unknown;
				lockfileMocks.lock.mockImplementation(async (_file: string, options: Record<string, unknown>) => {
					const onCompromised =
						typeof options?.onCompromised === "function"
							? (options.onCompromised as (err: unknown) => void)
							: properLockfileDefaultOnCompromised;
					return async () => {
						await lockfileMocks.release();
						try {
							onCompromised(genuine);
						} catch (thrown) {
							unhandled = thrown;
						}
					};
				});

				const lockedFileSystem = new LockedFileSystem();
				await lockedFileSystem.withLock({ path: indexPath, type: "file" }, async () => {});

				// Genuine compromise surfaces (the throwing handler fires). This is
				// true on both unfixed (library default rethrows) and fixed
				// (defaultOnCompromised rethrows non-release-race errors) code.
				expect(unhandled).toBe(genuine);
			} finally {
				tempDir.cleanup();
			}
		});
	}

	// --- Preservation 4: Request-supplied onCompromised precedence --------------
	//
	// A caller-provided onCompromised must be honored and preferred over any
	// default the fix installs. We assert the exact handler reference is passed
	// through to proper-lockfile, and that it (not a default) is the one invoked
	// when a compromise occurs — across several syscall/error shapes.
	it("forwards the exact request-supplied onCompromised reference to proper-lockfile", async () => {
		const tempDir = createTempDir("kanban-locked-fs-preserve-");
		try {
			const filePath = join(tempDir.path, "state.json");
			const lockedFileSystem = new LockedFileSystem();
			const onCompromised = vi.fn();

			await lockedFileSystem.withLock({ path: filePath, type: "file", onCompromised }, async () => {});

			const options = lockfileMocks.lock.mock.calls[0]?.[1] as Record<string, unknown>;
			expect(options.onCompromised).toBe(onCompromised);
		} finally {
			tempDir.cleanup();
		}
	});

	it("invokes the request-supplied onCompromised (and no default) when a compromise fires", async () => {
		const random = createSeededRandom(0xc0ff_ee01);
		const syscalls: ReadonlyArray<"utime" | "utimes" | "stat"> = ["utime", "utimes", "stat"];

		for (let iteration = 0; iteration < 12; iteration += 1) {
			const tempDir = createTempDir("kanban-locked-fs-preserve-");
			try {
				const indexPath = join(tempDir.path, "workspaces", "index.json");
				const lockfilePath = `${indexPath}.lock`;
				// Even a release-race-shaped compromise must be routed to the
				// caller's handler when one is supplied — the request handler wins.
				const syscall = syscalls[Math.floor(random() * syscalls.length)] ?? "utime";
				const compromise = createReleaseRaceCompromise(syscall, lockfilePath);

				const received: unknown[] = [];
				const onCompromised = vi.fn((err: unknown) => {
					received.push(err);
				});

				let unhandled: unknown;
				lockfileMocks.lock.mockImplementation(async (_file: string, options: Record<string, unknown>) => {
					const handler = options?.onCompromised as ((err: unknown) => void) | undefined;
					return async () => {
						await lockfileMocks.release();
						try {
							// The options MUST carry the caller's handler.
							(handler ?? properLockfileDefaultOnCompromised)(compromise);
						} catch (thrown) {
							unhandled = thrown;
						}
					};
				});

				const lockedFileSystem = new LockedFileSystem();
				await lockedFileSystem.withLock({ path: indexPath, type: "file", onCompromised }, async () => {});

				const options = lockfileMocks.lock.mock.calls[0]?.[1] as Record<string, unknown>;
				expect(options.onCompromised).toBe(onCompromised);
				expect(onCompromised).toHaveBeenCalledTimes(1);
				expect(received).toEqual([compromise]);
				// The caller's handler here does not throw, so nothing escapes.
				expect(unhandled).toBeUndefined();

				lockfileMocks.lock.mockReset();
				lockfileMocks.release.mockReset();
				lockfileMocks.release.mockResolvedValue(undefined);
			} finally {
				tempDir.cleanup();
			}
		}
	});
});
