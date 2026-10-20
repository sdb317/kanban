import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getSystemErrorName } from "node:util";
import type { LockOptions } from "proper-lockfile";
import * as lockfile from "proper-lockfile";
import { getKanbanRuntimeLogger } from "../cline-sdk/cline-runtime-logger.js";

const DEFAULT_LOCK_STALE_MS = 10_000;
const DEFAULT_LOCK_RETRIES: NonNullable<LockOptions["retries"]> = {
	retries: 200,
	factor: 1,
	minTimeout: 25,
	maxTimeout: 50,
	randomize: false,
};

interface BaseLockRequest {
	path: string;
	staleMs?: number;
	retries?: LockOptions["retries"];
	onCompromised?: LockOptions["onCompromised"];
}

export interface FileLockRequest extends BaseLockRequest {
	type?: "file";
	lockfilePath?: string;
}

export interface DirectoryLockRequest extends BaseLockRequest {
	type: "directory";
	lockfileName?: string;
	lockfilePath?: string;
}

export type LockRequest = FileLockRequest | DirectoryLockRequest;

interface NormalizedLockRequest {
	path: string;
	options: LockOptions;
	sortKey: string;
}

export interface AtomicTextWriteOptions {
	lock?: LockRequest | null;
	executable?: boolean;
}

const RELEASE_RACE_SYSCALLS: ReadonlySet<string> = new Set(["utime", "utimes", "stat"]);

interface CompromisedLockErrorShape {
	code?: unknown;
	syscall?: unknown;
	errno?: unknown;
	message?: unknown;
}

function isEnoentErrno(errno: unknown): boolean {
	if (typeof errno !== "number" || !Number.isInteger(errno) || errno >= 0) {
		return false;
	}
	try {
		// Platform-correct: -2 on POSIX, -4058 (UV_ENOENT) on Windows.
		return getSystemErrorName(errno) === "ENOENT";
	} catch {
		return false;
	}
}

/**
 * proper-lockfile's refresh timer can run `stat`/`utimes` against the lock file
 * after our own release already removed it. The library reassigns `code` to
 * ECOMPROMISED on the original ENOENT error, preserving syscall/errno/message,
 * which is the signature we use to recognize this benign race.
 */
function isReleaseRaceCompromise(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false;
	}
	const { code, syscall, errno, message } = error as CompromisedLockErrorShape;
	if (code !== "ECOMPROMISED" || typeof syscall !== "string" || !RELEASE_RACE_SYSCALLS.has(syscall)) {
		return false;
	}
	return isEnoentErrno(errno) || (typeof message === "string" && /\bENOENT\b/.test(message));
}

function defaultOnCompromised(error: Error): void {
	if (isReleaseRaceCompromise(error)) {
		const { syscall, path } = error as Error & { syscall?: string; path?: string };
		getKanbanRuntimeLogger().debug("locked-fs.compromise.release-race-tolerated", {
			syscall,
			path,
			message: error.message,
		});
		return;
	}
	// Genuine compromise: preserve proper-lockfile's default surfacing.
	throw error;
}

function createLockOptions(request: LockRequest, lockfilePath: string): LockOptions {
	return {
		stale: request.staleMs ?? DEFAULT_LOCK_STALE_MS,
		retries: request.retries ?? DEFAULT_LOCK_RETRIES,
		realpath: false,
		lockfilePath,
		onCompromised: request.onCompromised ?? defaultOnCompromised,
	};
}

async function readFileIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

export class LockedFileSystem {
	private async normalizeLockRequest(request: LockRequest): Promise<NormalizedLockRequest> {
		if (request.type === "directory") {
			await mkdir(request.path, { recursive: true });
			const lockfilePath = request.lockfilePath ?? join(request.path, request.lockfileName ?? ".lock");
			return {
				path: request.path,
				options: createLockOptions(request, lockfilePath),
				sortKey: lockfilePath,
			};
		}

		await mkdir(dirname(request.path), { recursive: true });
		const lockfilePath = request.lockfilePath ?? `${request.path}.lock`;
		return {
			path: request.path,
			options: createLockOptions(request, lockfilePath),
			sortKey: lockfilePath,
		};
	}

	async withLock<T>(request: LockRequest, operation: () => Promise<T>): Promise<T> {
		return await this.withLocks([request], operation);
	}

	async withLocks<T>(requests: readonly LockRequest[], operation: () => Promise<T>): Promise<T> {
		const normalizedRequests = await Promise.all(
			requests.map(async (request) => await this.normalizeLockRequest(request)),
		);
		const orderedRequests = normalizedRequests
			.slice()
			.sort((left, right) => left.sortKey.localeCompare(right.sortKey));
		const releases: Array<() => Promise<void>> = [];
		try {
			for (const request of orderedRequests) {
				releases.push(await lockfile.lock(request.path, request.options));
			}
			return await operation();
		} finally {
			for (const release of releases.reverse()) {
				await release();
			}
		}
	}

	async writeTextFileAtomic(path: string, content: string, options: AtomicTextWriteOptions = {}): Promise<void> {
		const lockRequest: LockRequest | null =
			options.lock === undefined
				? {
						path,
						type: "file" as const,
					}
				: options.lock;
		const writeOperation = async () => {
			const existingContent = await readFileIfExists(path);
			if (existingContent === content) {
				if (options.executable) {
					await chmod(path, 0o755);
				}
				return;
			}
			await mkdir(dirname(path), { recursive: true });
			const tempPath = `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
			await writeFile(tempPath, content, "utf8");
			await rename(tempPath, path);
			if (options.executable) {
				await chmod(path, 0o755);
			}
		};
		if (lockRequest) {
			await this.withLock(lockRequest, writeOperation);
			return;
		}
		await writeOperation();
	}

	async writeJsonFileAtomic(
		path: string,
		payload: unknown,
		options: Omit<AtomicTextWriteOptions, "executable"> = {},
	): Promise<void> {
		await this.writeTextFileAtomic(path, JSON.stringify(payload, null, 2), options);
	}

	async removePath(path: string, options: { lock: LockRequest; recursive?: boolean; force?: boolean }): Promise<void> {
		await this.withLock(options.lock, async () => {
			await rm(path, {
				recursive: options.recursive,
				force: options.force,
			});
		});
	}
}

export const lockedFileSystem = new LockedFileSystem();
