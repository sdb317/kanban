import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Windows atomic-write regression coverage.
 *
 * On Windows, `fs.rename` over an existing destination throws EPERM/EACCES/EBUSY
 * when another process (antivirus, Search indexer, an editor, or the agent CLI)
 * holds the target file open. This surfaced as:
 *
 *   EPERM: operation not permitted, rename
 *     '...\.kiro\agents\kanban.json.tmp.<pid>.<ts>.<uuid>' -> '...\.kiro\agents\kanban.json'
 *
 * which silently prevented starting a Kiro task (the agent config write in
 * `agent-session-adapters.ts` flows through `writeTextFileAtomic`).
 *
 * `renameWithRetry` must: retry the rename on those transient codes, fall back
 * to an in-place overwrite when the lock persists, and always clean up the temp
 * file — without changing POSIX behavior or the non-retryable error path.
 *
 * These tests mock `node:fs/promises` so the retry/fallback branches are driven
 * deterministically regardless of the host platform.
 */

const fsMocks = vi.hoisted(() => ({
	rename: vi.fn(),
	writeFile: vi.fn(async () => {}),
	readFile: vi.fn(async () => ""),
	rm: vi.fn(async () => {}),
	mkdir: vi.fn(async () => undefined),
	chmod: vi.fn(async () => {}),
}));

vi.mock("node:fs/promises", () => ({
	rename: fsMocks.rename,
	writeFile: fsMocks.writeFile,
	readFile: fsMocks.readFile,
	rm: fsMocks.rm,
	mkdir: fsMocks.mkdir,
	chmod: fsMocks.chmod,
}));

// Writes with no `lock` request skip proper-lockfile entirely, so the mocked
// lock simply needs to exist for import resolution.
vi.mock("proper-lockfile", () => ({
	lock: vi.fn(async () => async () => {}),
}));

import { LockedFileSystem } from "../../src/fs/locked-file-system";

function makeFsError(code: string, message: string): NodeJS.ErrnoException {
	return Object.assign(new Error(message), { code }) as NodeJS.ErrnoException;
}

const PATH = "C:/Users/Bells/.kiro/agents/kanban.json";
const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("LockedFileSystem.writeTextFileAtomic rename retry (Windows lock handling)", () => {
	beforeEach(() => {
		for (const mock of Object.values(fsMocks)) {
			mock.mockReset();
		}
		fsMocks.writeFile.mockResolvedValue(undefined);
		fsMocks.rm.mockResolvedValue(undefined);
		fsMocks.mkdir.mockResolvedValue(undefined);
		fsMocks.chmod.mockResolvedValue(undefined);
		// readFileIfExists reads the destination first; ENOENT means "no existing file".
		fsMocks.readFile.mockRejectedValue(makeFsError("ENOENT", "no such file"));
	});

	afterEach(() => {
		setPlatform(originalPlatform);
		vi.useRealTimers();
	});

	it("retries a transient EPERM rename on Windows and then succeeds", async () => {
		setPlatform("win32");
		fsMocks.rename
			.mockRejectedValueOnce(makeFsError("EPERM", "operation not permitted, rename"))
			.mockRejectedValueOnce(makeFsError("EPERM", "operation not permitted, rename"))
			.mockResolvedValueOnce(undefined);

		const lockedFileSystem = new LockedFileSystem();
		await lockedFileSystem.writeTextFileAtomic(PATH, "payload", { lock: null });

		expect(fsMocks.rename).toHaveBeenCalledTimes(3);
		// Succeeded via rename — no fallback overwrite to the destination.
		expect(fsMocks.writeFile).toHaveBeenCalledTimes(1); // only the temp write
		expect(fsMocks.writeFile).toHaveBeenCalledWith(expect.stringContaining(`${PATH}.tmp.`), "payload", "utf8");
	});

	it("falls back to an in-place overwrite when the destination stays locked", async () => {
		setPlatform("win32");
		fsMocks.rename.mockRejectedValue(makeFsError("EPERM", "operation not permitted, rename"));
		// The fallback reads the temp file, then writes the destination directly.
		fsMocks.readFile.mockImplementation(async (target: string) => {
			if (target === PATH) {
				throw makeFsError("ENOENT", "no such file");
			}
			return "payload"; // temp file contents
		});

		const lockedFileSystem = new LockedFileSystem();
		await lockedFileSystem.writeTextFileAtomic(PATH, "payload", { lock: null });

		// Destination written in place as the fallback.
		expect(fsMocks.writeFile).toHaveBeenCalledWith(PATH, "payload", "utf8");
		// Temp file cleaned up after the successful fallback.
		expect(fsMocks.rm).toHaveBeenCalledWith(expect.stringContaining(`${PATH}.tmp.`), { force: true });
	});

	it("does not retry on non-win32 and surfaces the error, cleaning up the temp file", async () => {
		setPlatform("linux");
		const eperm = makeFsError("EPERM", "operation not permitted, rename");
		fsMocks.rename.mockRejectedValue(eperm);

		const lockedFileSystem = new LockedFileSystem();
		await expect(lockedFileSystem.writeTextFileAtomic(PATH, "payload", { lock: null })).rejects.toBe(eperm);

		expect(fsMocks.rename).toHaveBeenCalledTimes(1);
		expect(fsMocks.rm).toHaveBeenCalledWith(expect.stringContaining(`${PATH}.tmp.`), { force: true });
	});

	it("does not retry a non-lock rename error even on Windows", async () => {
		setPlatform("win32");
		const enospc = makeFsError("ENOSPC", "no space left on device");
		fsMocks.rename.mockRejectedValue(enospc);

		const lockedFileSystem = new LockedFileSystem();
		await expect(lockedFileSystem.writeTextFileAtomic(PATH, "payload", { lock: null })).rejects.toBe(enospc);

		expect(fsMocks.rename).toHaveBeenCalledTimes(1);
	});
});
