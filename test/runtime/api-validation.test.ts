import { describe, expect, it } from "vitest";

import {
	parseHookIngestRequest,
	parseShellSessionStartRequest,
	parseTaskSessionStartRequest,
	parseWorkspaceFileSearchRequest,
	parseWorktreeEnsureRequest,
} from "../../src/core/api-validation";

describe("parseWorkspaceFileSearchRequest", () => {
	it("parses q and limit", () => {
		const parsed = parseWorkspaceFileSearchRequest(new URLSearchParams({ q: "  src/runtime ", limit: "25" }));
		expect(parsed).toEqual({
			query: "src/runtime",
			limit: 25,
		});
	});

	it("treats missing q as empty query", () => {
		const parsed = parseWorkspaceFileSearchRequest(new URLSearchParams({ limit: "10" }));
		expect(parsed).toEqual({
			query: "",
		});
	});

	it("does not accept legacy query alias", () => {
		const parsed = parseWorkspaceFileSearchRequest(new URLSearchParams({ query: "legacy" }));
		expect(parsed).toEqual({
			query: "",
		});
	});

	it("throws when limit is invalid", () => {
		expect(() => {
			parseWorkspaceFileSearchRequest(new URLSearchParams({ q: "board", limit: "0" }));
		}).toThrow("Invalid file search limit parameter.");
	});
});

describe("parseHookIngestRequest", () => {
	it("parses and trims task and workspace identifiers", () => {
		const parsed = parseHookIngestRequest({
			taskId: "  task-123  ",
			workspaceId: "  workspace-456  ",
			event: "to_review",
			metadata: {
				source: " claude ",
				activityText: " Using Read ",
			},
		});
		expect(parsed).toEqual({
			taskId: "task-123",
			workspaceId: "workspace-456",
			event: "to_review",
			metadata: {
				source: "claude",
				activityText: "Using Read",
				hookEventName: undefined,
				toolName: undefined,
				finalMessage: undefined,
				notificationType: undefined,
			},
		});
	});

	it("throws when workspaceId is missing", () => {
		expect(() => {
			parseHookIngestRequest({
				taskId: "task-1",
				workspaceId: "   ",
				event: "to_review",
			});
		}).toThrow("Missing workspaceId");
	});
});

describe("parseTaskSessionStartRequest", () => {
	it("parses resumeFromTrash and trims task identifiers", () => {
		const parsed = parseTaskSessionStartRequest({
			taskId: "  task-1  ",
			prompt: "",
			baseRef: "  main  ",
			resumeFromTrash: true,
		});
		expect(parsed).toEqual({
			taskId: "task-1",
			prompt: "",
			baseRef: "main",
			resumeFromTrash: true,
		});
	});

	it("throws on empty baseRef by default", () => {
		expect(() => {
			parseTaskSessionStartRequest({ taskId: "task-1", prompt: "", baseRef: "   " });
		}).toThrow("Task session baseRef cannot be empty.");
	});

	it("accepts empty baseRef when allowEmptyBaseRef is true", () => {
		const parsed = parseTaskSessionStartRequest(
			{ taskId: "  task-1  ", prompt: "", baseRef: "   " },
			{ allowEmptyBaseRef: true },
		);
		expect(parsed.taskId).toBe("task-1");
		expect(parsed.baseRef).toBe("");
	});

	it("still requires taskId when allowEmptyBaseRef is true", () => {
		expect(() => {
			parseTaskSessionStartRequest({ taskId: "   ", prompt: "", baseRef: "" }, { allowEmptyBaseRef: true });
		}).toThrow("Task session taskId cannot be empty.");
	});
});

describe("parseWorktreeEnsureRequest", () => {
	it("throws on empty baseRef by default", () => {
		expect(() => {
			parseWorktreeEnsureRequest({ taskId: "task-1", baseRef: "   " });
		}).toThrow("Invalid worktree ensure payload.");
	});

	it("accepts empty baseRef when allowEmptyBaseRef is true", () => {
		const parsed = parseWorktreeEnsureRequest({ taskId: "  task-1  ", baseRef: "   " }, { allowEmptyBaseRef: true });
		expect(parsed).toEqual({ taskId: "task-1", baseRef: "" });
	});

	it("still requires taskId when allowEmptyBaseRef is true", () => {
		expect(() => {
			parseWorktreeEnsureRequest({ taskId: "   ", baseRef: "" }, { allowEmptyBaseRef: true });
		}).toThrow("Invalid worktree ensure payload.");
	});
});

describe("parseShellSessionStartRequest", () => {
	it("throws on empty baseRef by default", () => {
		expect(() => {
			parseShellSessionStartRequest({ taskId: "task-1", baseRef: "   " });
		}).toThrow("Shell session baseRef cannot be empty.");
	});

	it("accepts empty baseRef when allowEmptyBaseRef is true", () => {
		const parsed = parseShellSessionStartRequest(
			{ taskId: "  task-1  ", baseRef: "   " },
			{ allowEmptyBaseRef: true },
		);
		expect(parsed.taskId).toBe("task-1");
		expect(parsed.baseRef).toBe("");
	});

	it("still requires taskId when allowEmptyBaseRef is true", () => {
		expect(() => {
			parseShellSessionStartRequest({ taskId: "   ", baseRef: "" }, { allowEmptyBaseRef: true });
		}).toThrow("Shell session taskId cannot be empty.");
	});
});
