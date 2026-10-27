import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveWindowsExecutableAbsolutePath, shouldUseWindowsCmdLaunch } from "../../../src/core/windows-cmd-launch";

function createWindowsBinary(directory: string, fileName: string): string {
	const filePath = join(directory, fileName);
	writeFileSync(filePath, "");
	return filePath;
}

describe("shouldUseWindowsCmdLaunch", () => {
	const tempDirectories: string[] = [];

	afterEach(() => {
		for (const directory of tempDirectories) {
			rmSync(directory, { recursive: true, force: true });
		}
		tempDirectories.length = 0;
	});

	it("returns false outside Windows", () => {
		expect(shouldUseWindowsCmdLaunch("codex", "darwin")).toBe(false);
	});

	it("returns false for explicit .exe binaries", () => {
		expect(shouldUseWindowsCmdLaunch("codex.exe", "win32")).toBe(false);
	});

	it("returns true for explicit .cmd shims", () => {
		expect(shouldUseWindowsCmdLaunch("codex.cmd", "win32")).toBe(true);
	});

	it("returns false when PATH resolves a bare binary to .exe", () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "kanban-win-launch-"));
		tempDirectories.push(tempDirectory);
		createWindowsBinary(tempDirectory, "codex.exe");

		expect(
			shouldUseWindowsCmdLaunch("codex", "win32", {
				PATH: tempDirectory,
				PATHEXT: ".com;.exe;.bat;.cmd",
				ComSpec: "C:\\Windows\\System32\\cmd.exe",
			}),
		).toBe(false);
	});

	it("treats Windows env keys case-insensitively when PATH resolves a bare binary to .exe", () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "kanban-win-launch-"));
		tempDirectories.push(tempDirectory);
		createWindowsBinary(tempDirectory, "codex.exe");

		expect(
			shouldUseWindowsCmdLaunch("codex", "win32", {
				Path: tempDirectory,
				Pathext: ".com;.exe;.bat;.cmd",
				comspec: "C:\\Windows\\System32\\cmd.exe",
			}),
		).toBe(false);
	});

	it("uses defined case-insensitive PATH when duplicate keys include undefined", () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "kanban-win-launch-"));
		tempDirectories.push(tempDirectory);
		createWindowsBinary(tempDirectory, "codex.exe");

		expect(
			shouldUseWindowsCmdLaunch("codex", "win32", {
				PATH: undefined,
				Path: tempDirectory,
				PATHEXT: ".com;.exe;.bat;.cmd",
				ComSpec: "C:\\Windows\\System32\\cmd.exe",
			}),
		).toBe(false);
	});

	it("returns true when PATH resolves a bare binary to .cmd", () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "kanban-win-launch-"));
		tempDirectories.push(tempDirectory);
		createWindowsBinary(tempDirectory, "codex.cmd");

		expect(
			shouldUseWindowsCmdLaunch("codex", "win32", {
				PATH: tempDirectory,
				PATHEXT: ".com;.exe;.bat;.cmd",
				ComSpec: "C:\\Windows\\System32\\cmd.exe",
			}),
		).toBe(true);
	});

	it("keeps cmd wrapping fallback when resolution is ambiguous", () => {
		expect(
			shouldUseWindowsCmdLaunch("codex", "win32", {
				PATH: "",
				PATHEXT: ".com;.exe;.bat;.cmd",
				ComSpec: "C:\\Windows\\System32\\cmd.exe",
			}),
		).toBe(true);
	});
});

describe("resolveWindowsExecutableAbsolutePath", () => {
	const tempDirectories: string[] = [];

	afterEach(() => {
		for (const directory of tempDirectories) {
			rmSync(directory, { recursive: true, force: true });
		}
		tempDirectories.length = 0;
	});

	it("resolves a bare name to its absolute .exe path via PATH and PATHEXT", () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "kanban-win-resolve-"));
		tempDirectories.push(tempDirectory);
		const expected = createWindowsBinary(tempDirectory, "kiro-cli.exe");

		expect(
			resolveWindowsExecutableAbsolutePath("kiro-cli", {
				PATH: tempDirectory,
				PATHEXT: ".com;.exe;.bat;.cmd",
			}),
		).toBe(expected);
	});

	it("resolves a bare name supplied with an explicit extension", () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "kanban-win-resolve-"));
		tempDirectories.push(tempDirectory);
		const expected = createWindowsBinary(tempDirectory, "kiro-cli.exe");

		expect(
			resolveWindowsExecutableAbsolutePath("kiro-cli.exe", {
				PATH: tempDirectory,
				PATHEXT: ".com;.exe;.bat;.cmd",
			}),
		).toBe(expected);
	});

	it("treats Windows env keys case-insensitively", () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "kanban-win-resolve-"));
		tempDirectories.push(tempDirectory);
		const expected = createWindowsBinary(tempDirectory, "kiro-cli.exe");

		expect(
			resolveWindowsExecutableAbsolutePath("kiro-cli", {
				Path: tempDirectory,
				Pathext: ".com;.exe;.bat;.cmd",
			}),
		).toBe(expected);
	});

	it("returns an existing absolute path unchanged", () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "kanban-win-resolve-"));
		tempDirectories.push(tempDirectory);
		const absolute = createWindowsBinary(tempDirectory, "kiro-cli.exe");

		expect(resolveWindowsExecutableAbsolutePath(absolute, { PATH: "" })).toBe(absolute);
	});

	it("returns null when the binary cannot be found on PATH", () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "kanban-win-resolve-"));
		tempDirectories.push(tempDirectory);

		expect(
			resolveWindowsExecutableAbsolutePath("kiro-cli", {
				PATH: tempDirectory,
				PATHEXT: ".com;.exe;.bat;.cmd",
			}),
		).toBeNull();
	});

	it("returns null for an empty binary name", () => {
		expect(resolveWindowsExecutableAbsolutePath("   ", { PATH: "" })).toBeNull();
	});
});
