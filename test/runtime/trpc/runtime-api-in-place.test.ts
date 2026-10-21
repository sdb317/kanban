import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import { WORKTREES_REQUIRE_GIT_MESSAGE } from "../../../src/config/worktree-setting";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { renderInPlaceTaskAgentPrompt } from "../../../src/prompts/task-agent-prompt";

// Hoisted mock registries. We keep the same style as runtime-api.test.ts so the
// two suites share a mental model: all external SDK / git / checkpoint
// dependencies are replaced with vitest mocks and no real agent host, git
// process, or Cline SDK is ever booted (AGENTS.md Node 22 CI hang guidance).
const agentRegistryMocks = vi.hoisted(() => ({
	resolveAgentCommand: vi.fn(),
	buildRuntimeConfigResponse: vi.fn(),
}));

const taskWorktreeMocks = vi.hoisted(() => ({
	resolveTaskCwd: vi.fn(),
}));

const turnCheckpointMocks = vi.hoisted(() => ({
	captureTaskTurnCheckpoint: vi.fn(),
}));

const runtimeConfigMocks = vi.hoisted(() => ({
	updateRuntimeConfig: vi.fn(),
	updateGlobalRuntimeConfig: vi.fn(),
}));

const clineProviderMocks = vi.hoisted(() => ({
	getProviderSettingsSummary: vi.fn(() => ({})),
	resolveLaunchConfig: vi.fn(async () => ({
		providerId: "anthropic",
		modelId: "claude-sonnet-4-6",
		apiKey: "anthropic-api-key",
		baseUrl: undefined as string | undefined,
		reasoningEffort: null as string | null,
	})),
}));

const browserMocks = vi.hoisted(() => ({
	openInBrowser: vi.fn(),
}));

vi.mock("../../../src/terminal/agent-registry.js", () => ({
	resolveAgentCommand: agentRegistryMocks.resolveAgentCommand,
	buildRuntimeConfigResponse: agentRegistryMocks.buildRuntimeConfigResponse,
}));

vi.mock("../../../src/workspace/task-worktree.js", () => ({
	resolveTaskCwd: taskWorktreeMocks.resolveTaskCwd,
}));

vi.mock("../../../src/workspace/turn-checkpoints.js", () => ({
	captureTaskTurnCheckpoint: turnCheckpointMocks.captureTaskTurnCheckpoint,
}));

vi.mock("../../../src/config/runtime-config.js", () => ({
	updateRuntimeConfig: runtimeConfigMocks.updateRuntimeConfig,
	updateGlobalRuntimeConfig: runtimeConfigMocks.updateGlobalRuntimeConfig,
}));

// The runtime API constructs the real Cline provider / MCP services at module
// scope. Stub @clinebot/core so none of that touches a real SDK host.
vi.mock("@clinebot/core", () => ({
	addLocalProvider: vi.fn(),
	ensureCustomProvidersLoaded: vi.fn(),
	getLocalProviderModels: vi.fn(),
	getValidClineCredentials: vi.fn(),
	getValidOcaCredentials: vi.fn(),
	getValidOpenAICodexCredentials: vi.fn(),
	loginClineOAuth: vi.fn(),
	loginOcaOAuth: vi.fn(),
	loginOpenAICodex: vi.fn(),
	resolveDefaultMcpSettingsPath: vi.fn(() => "/tmp/mcp-settings.json"),
	resolveClineDataDir: vi.fn(() => "/tmp/cline"),
	loadMcpSettingsFile: vi.fn(() => ({ mcpServers: {} })),
	resolveProviderConfig: vi.fn(),
	ClineAccountService: class {
		fetchMe = vi.fn();
		fetchRemoteConfig = vi.fn();
		fetchOrganization = vi.fn();
		fetchFeaturebaseToken = vi.fn();
	},
	ProviderSettingsManager: class {
		saveProviderSettings = vi.fn();
		getProviderSettings = vi.fn();
		getLastUsedProviderSettings = vi.fn();
		getProviderConfig = vi.fn();
	},
	Llms: {
		getAllProviders: vi.fn(),
		getModelsForProvider: vi.fn(),
		resolveProviderModelCatalogKeys: vi.fn(),
	},
	LlmsModels: {
		CLINE_DEFAULT_MODEL: "anthropic/claude-sonnet-4.6",
		getAllProviders: vi.fn(),
		getModelsForProvider: vi.fn(),
	},
}));

vi.mock("../../../src/cline-sdk/cline-provider-service.js", () => ({
	createClineProviderService: () => ({
		getProviderSettingsSummary: clineProviderMocks.getProviderSettingsSummary,
		resolveLaunchConfig: clineProviderMocks.resolveLaunchConfig,
	}),
}));

vi.mock("../../../src/server/browser.js", () => ({
	openInBrowser: browserMocks.openInBrowser,
}));

import type { RuntimeTrpcContext } from "../../../src/trpc/app-router";
import { type CreateRuntimeApiDependencies, createRuntimeApi } from "../../../src/trpc/runtime-api";
import { createTaskWorkspaceProvider } from "../../../src/workspace/task-workspace-provider.js";

type RuntimeApi = RuntimeTrpcContext["runtimeApi"];

const WORKSPACE_ID = "workspace-1";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/project",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function createRuntimeConfigState(overrides: Partial<RuntimeConfigState> = {}): RuntimeConfigState {
	return {
		selectedAgentId: "claude",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		readyForReviewNotificationsEnabled: true,
		shortcuts: [],
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
		globalWorktreesEnabled: null,
		projectWorktreesEnabled: null,
		worktreesEnabled: false,
		...overrides,
	};
}

interface TerminalManagerMock {
	startTaskSession: ReturnType<typeof vi.fn>;
	startShellSession: ReturnType<typeof vi.fn>;
	applyTurnCheckpoint: ReturnType<typeof vi.fn>;
	clearTurnCheckpoints: ReturnType<typeof vi.fn>;
	getSummary: ReturnType<typeof vi.fn>;
}

function createTerminalManagerMock(
	startTaskSession: (request: { taskId: string }) => RuntimeTaskSessionSummary = (request) =>
		createSummary({ taskId: request.taskId }),
): TerminalManagerMock {
	return {
		startTaskSession: vi.fn(async (request: { taskId: string }) => startTaskSession(request)),
		startShellSession: vi.fn(async (request: { taskId: string }) => createSummary({ taskId: request.taskId })),
		applyTurnCheckpoint: vi.fn(() => null),
		clearTurnCheckpoints: vi.fn((taskId: string) =>
			createSummary({ taskId, latestTurnCheckpoint: null, previousTurnCheckpoint: null }),
		),
		getSummary: vi.fn(() => null),
	};
}

function createClineTaskSessionServiceMock() {
	return {
		startTaskSession: vi.fn(async () => createSummary({ agentId: "cline", pid: null })),
		clearTurnCheckpoints: vi.fn(() => null),
		applyTurnCheckpoint: vi.fn(() => null),
		rebindPersistedTaskSession: vi.fn(async () => null),
		getSummary: vi.fn(() => null),
	};
}

interface BuildApiOverrides {
	runtimeConfig?: RuntimeConfigState;
	worktreesEnabled?: boolean;
	terminalManager?: TerminalManagerMock;
	resolveTaskWorkspaceProvider?: CreateRuntimeApiDependencies["resolveTaskWorkspaceProvider"];
	setActiveRuntimeConfig?: CreateRuntimeApiDependencies["setActiveRuntimeConfig"];
	getActiveRuntimeConfig?: CreateRuntimeApiDependencies["getActiveRuntimeConfig"];
	resolveInteractiveShellCommand?: CreateRuntimeApiDependencies["resolveInteractiveShellCommand"];
}

function buildApi(overrides: BuildApiOverrides = {}): {
	api: RuntimeApi;
	terminalManager: TerminalManagerMock;
	clineTaskSessionService: ReturnType<typeof createClineTaskSessionServiceMock>;
	loadEffectiveWorktreesEnabled: ReturnType<typeof vi.fn>;
} {
	const runtimeConfig = overrides.runtimeConfig ?? createRuntimeConfigState();
	const worktreesEnabled = overrides.worktreesEnabled ?? false;
	const terminalManager = overrides.terminalManager ?? createTerminalManagerMock();
	const clineTaskSessionService = createClineTaskSessionServiceMock();
	const loadEffectiveWorktreesEnabled = vi.fn(async () => worktreesEnabled);

	agentRegistryMocks.resolveAgentCommand.mockReturnValue({
		agentId: runtimeConfig.selectedAgentId,
		label: "Agent",
		command: runtimeConfig.selectedAgentId,
		binary: runtimeConfig.selectedAgentId,
		args: [],
	});

	const api = createRuntimeApi({
		getActiveWorkspaceId: vi.fn(() => WORKSPACE_ID),
		getActiveRuntimeConfig: overrides.getActiveRuntimeConfig,
		loadScopedRuntimeConfig: vi.fn(async () => runtimeConfig),
		setActiveRuntimeConfig: overrides.setActiveRuntimeConfig ?? vi.fn(),
		getScopedTerminalManager: vi.fn(async () => terminalManager as never),
		getScopedClineTaskSessionService: vi.fn(async () => clineTaskSessionService as never),
		loadEffectiveWorktreesEnabled,
		resolveTaskWorkspaceProvider: overrides.resolveTaskWorkspaceProvider ?? createTaskWorkspaceProvider,
		resolveInteractiveShellCommand:
			overrides.resolveInteractiveShellCommand ?? vi.fn(() => ({ binary: "bash", args: [] })),
		runCommand: vi.fn(),
		getUpdateStatus: vi.fn(() => ({
			currentVersion: "0.1.0",
			latestVersion: null,
			updateAvailable: false,
			updateTiming: null,
			installCommand: null,
		})),
		runUpdateNow: vi.fn(async () => ({
			status: "unsupported_installation" as const,
			currentVersion: "0.1.0",
			latestVersion: null,
			message: "unsupported",
		})),
	});

	return { api, terminalManager, clineTaskSessionService, loadEffectiveWorktreesEnabled };
}

describe("createRuntimeApi In-Place Mode", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = mkdtempSync(join(tmpdir(), "kanban-in-place-"));
		agentRegistryMocks.resolveAgentCommand.mockReset();
		agentRegistryMocks.buildRuntimeConfigResponse.mockReset();
		agentRegistryMocks.buildRuntimeConfigResponse.mockImplementation((config: RuntimeConfigState) => ({
			config,
		}));
		taskWorktreeMocks.resolveTaskCwd.mockReset();
		turnCheckpointMocks.captureTaskTurnCheckpoint.mockReset();
		runtimeConfigMocks.updateRuntimeConfig.mockReset();
		runtimeConfigMocks.updateGlobalRuntimeConfig.mockReset();
		browserMocks.openInBrowser.mockReset();
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("starts a task session with the project path as the cwd in In-Place Mode (Req 3.2)", async () => {
		const { api, terminalManager, loadEffectiveWorktreesEnabled } = buildApi({ worktreesEnabled: false });

		const response = await api.startTaskSession(
			{ workspaceId: WORKSPACE_ID, workspacePath: projectDir },
			{ taskId: "task-1", baseRef: "", prompt: "Do the thing" },
		);

		expect(response.ok).toBe(true);
		expect(loadEffectiveWorktreesEnabled).toHaveBeenCalledWith(projectDir);
		// In-Place Mode never routes through the worktree helper.
		expect(taskWorktreeMocks.resolveTaskCwd).not.toHaveBeenCalled();
		expect(terminalManager.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: "task-1", cwd: projectDir }),
		);
	});

	it("starts a task-scoped shell session with the project path as the cwd in In-Place Mode (Req 3.3)", async () => {
		const { api, terminalManager } = buildApi({ worktreesEnabled: false });

		const response = await api.startShellSession(
			{ workspaceId: WORKSPACE_ID, workspacePath: projectDir },
			{ taskId: "shell-1", workspaceTaskId: "task-1", baseRef: "", cols: 80, rows: 24 },
		);

		expect(response.ok).toBe(true);
		expect(taskWorktreeMocks.resolveTaskCwd).not.toHaveBeenCalled();
		expect(terminalManager.startShellSession).toHaveBeenCalledWith(
			expect.objectContaining({ taskId: "shell-1", cwd: projectDir }),
		);
	});

	it("allows ten concurrent task starts in the same project with no concurrency cap (Req 3.6)", async () => {
		const { api, terminalManager } = buildApi({ worktreesEnabled: false });

		const responses = await Promise.all(
			Array.from({ length: 10 }, (_unused, index) =>
				api.startTaskSession(
					{ workspaceId: WORKSPACE_ID, workspacePath: projectDir },
					{ taskId: `task-${index}`, baseRef: "", prompt: `Prompt ${index}` },
				),
			),
		);

		expect(responses).toHaveLength(10);
		expect(responses.every((response) => response.ok && response.summary?.state === "running")).toBe(true);
		expect(terminalManager.startTaskSession).toHaveBeenCalledTimes(10);
		const startedTaskIds = terminalManager.startTaskSession.mock.calls.map((call) => call[0].taskId);
		expect(new Set(startedTaskIds).size).toBe(10);
		for (const call of terminalManager.startTaskSession.mock.calls) {
			expect(call[0].cwd).toBe(projectDir);
		}
	});

	it("rejects the task start with a 'Project folder is unavailable' error when the folder is missing (Req 3.9)", async () => {
		const missingPath = join(projectDir, "does-not-exist");
		const { api, terminalManager } = buildApi({ worktreesEnabled: false });

		const response = await api.startTaskSession(
			{ workspaceId: WORKSPACE_ID, workspacePath: missingPath },
			{ taskId: "task-1", baseRef: "", prompt: "Do the thing" },
		);

		expect(response.ok).toBe(false);
		expect(response.summary).toBeNull();
		expect(response.error).toContain("Project folder is unavailable");
		expect(response.error).toContain(missingPath);
		// The handler returns { ok: false } rather than throwing.
		expect(terminalManager.startTaskSession).not.toHaveBeenCalled();
	});

	it("passes the In-Place task prompt to the terminal manager and involves no commit/PR template (Req 11.7, 11.8)", async () => {
		// Distinctive template sentinels so the "no commit/PR template" assertions
		// below are meaningful and cannot accidentally match other prompt text.
		const runtimeConfig = createRuntimeConfigState({
			commitPromptTemplate: "COMMIT_TEMPLATE_SENTINEL",
			openPrPromptTemplate: "OPEN_PR_TEMPLATE_SENTINEL",
		});
		const { api, terminalManager } = buildApi({ worktreesEnabled: false, runtimeConfig });

		const response = await api.startTaskSession(
			{ workspaceId: WORKSPACE_ID, workspacePath: projectDir },
			{ taskId: "task-1", baseRef: "", prompt: "Do the thing" },
		);

		expect(response.ok).toBe(true);
		const startArgs = terminalManager.startTaskSession.mock.calls[0]?.[0];
		const appendSystemPrompt = startArgs?.appendSystemPrompt;
		expect(appendSystemPrompt).toBe(renderInPlaceTaskAgentPrompt(projectDir));
		// No commit/PR template is involved: the resolved prompt is the In-Place task
		// prompt and carries none of the commit/openPr template text from config.
		expect(appendSystemPrompt).not.toContain("COMMIT_TEMPLATE_SENTINEL");
		expect(appendSystemPrompt).not.toContain("OPEN_PR_TEMPLATE_SENTINEL");
		expect(appendSystemPrompt).not.toContain("pull request");
		expect(appendSystemPrompt).not.toContain("Open PR");
	});

	it("passes the In-Place task prompt through the Cline service and never captures checkpoints (Req 11.7, 11.8)", async () => {
		const runtimeConfig = createRuntimeConfigState({ selectedAgentId: "cline" });
		agentRegistryMocks.resolveAgentCommand.mockReturnValue(null);
		const { api, clineTaskSessionService } = buildApi({ worktreesEnabled: false, runtimeConfig });

		const response = await api.startTaskSession(
			{ workspaceId: WORKSPACE_ID, workspacePath: projectDir },
			{ taskId: "task-1", baseRef: "", prompt: "Do the thing" },
		);

		expect(response.ok).toBe(true);
		expect(clineTaskSessionService.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: projectDir,
				appendSystemPrompt: renderInPlaceTaskAgentPrompt(projectDir),
			}),
		);
		expect(turnCheckpointMocks.captureTaskTurnCheckpoint).not.toHaveBeenCalled();
		// In-Place Mode clears stale checkpoint fields instead of capturing new ones.
		expect(clineTaskSessionService.clearTurnCheckpoints).toHaveBeenCalledWith("task-1");
	});

	it("resolves mode once at start so a running session keeps its cwd and prompt after a mode flip (Req 11.9, 12.8)", async () => {
		// The mode is read exactly once per start, and the terminal manager stores
		// the resolved request for restarts. A later flip of the effective setting
		// must not change the cwd or prompt that were captured at start time.
		const worktreesEnabledRef = { value: false };
		const loadEffectiveWorktreesEnabled = vi.fn(async () => worktreesEnabledRef.value);
		const terminalManager = createTerminalManagerMock();
		agentRegistryMocks.resolveAgentCommand.mockReturnValue({
			agentId: "claude",
			label: "Claude Code",
			command: "claude",
			binary: "claude",
			args: [],
		});

		const api = createRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => WORKSPACE_ID),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => terminalManager as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			loadEffectiveWorktreesEnabled,
			resolveTaskWorkspaceProvider: createTaskWorkspaceProvider,
			resolveInteractiveShellCommand: vi.fn(() => ({ binary: "bash", args: [] })),
			runCommand: vi.fn(),
			getUpdateStatus: vi.fn(() => ({
				currentVersion: "0.1.0",
				latestVersion: null,
				updateAvailable: false,
				updateTiming: null,
				installCommand: null,
			})),
			runUpdateNow: vi.fn(async () => ({
				status: "unsupported_installation" as const,
				currentVersion: "0.1.0",
				latestVersion: null,
				message: "unsupported",
			})),
		});

		const first = await api.startTaskSession(
			{ workspaceId: WORKSPACE_ID, workspacePath: projectDir },
			{ taskId: "task-1", baseRef: "", prompt: "Do the thing" },
		);
		expect(first.ok).toBe(true);

		const firstStartArgs = terminalManager.startTaskSession.mock.calls[0]?.[0];
		expect(firstStartArgs?.cwd).toBe(projectDir);
		expect(firstStartArgs?.appendSystemPrompt).toBe(renderInPlaceTaskAgentPrompt(projectDir));

		// Flip the effective mode. The already-running session's captured request
		// (held by the terminal manager) is unaffected; mode is only consulted on
		// the next explicit start call.
		worktreesEnabledRef.value = true;
		expect(loadEffectiveWorktreesEnabled).toHaveBeenCalledTimes(1);
		expect(firstStartArgs?.cwd).toBe(projectDir);
		expect(firstStartArgs?.appendSystemPrompt).toBe(renderInPlaceTaskAgentPrompt(projectDir));
	});
});

describe("createRuntimeApi saveConfig error mapping", () => {
	beforeEach(() => {
		agentRegistryMocks.buildRuntimeConfigResponse.mockReset();
		agentRegistryMocks.buildRuntimeConfigResponse.mockImplementation((config: RuntimeConfigState) => ({
			config,
		}));
		runtimeConfigMocks.updateRuntimeConfig.mockReset();
		runtimeConfigMocks.updateGlobalRuntimeConfig.mockReset();
	});

	function buildConfigApi(): RuntimeApi {
		return createRuntimeApi({
			getActiveWorkspaceId: vi.fn(() => WORKSPACE_ID),
			loadScopedRuntimeConfig: vi.fn(async () => createRuntimeConfigState()),
			setActiveRuntimeConfig: vi.fn(),
			getScopedTerminalManager: vi.fn(async () => createTerminalManagerMock() as never),
			getScopedClineTaskSessionService: vi.fn(async () => createClineTaskSessionServiceMock() as never),
			loadEffectiveWorktreesEnabled: vi.fn(async () => false),
			resolveTaskWorkspaceProvider: createTaskWorkspaceProvider,
			resolveInteractiveShellCommand: vi.fn(() => ({ binary: "bash", args: [] })),
			runCommand: vi.fn(),
			getUpdateStatus: vi.fn(() => ({
				currentVersion: "0.1.0",
				latestVersion: null,
				updateAvailable: false,
				updateTiming: null,
				installCommand: null,
			})),
			runUpdateNow: vi.fn(async () => ({
				status: "unsupported_installation" as const,
				currentVersion: "0.1.0",
				latestVersion: null,
				message: "unsupported",
			})),
		});
	}

	it("maps the git-repo guard error to a BAD_REQUEST TRPCError (Req 2.7, 14.5)", async () => {
		runtimeConfigMocks.updateRuntimeConfig.mockRejectedValue(new Error(WORKTREES_REQUIRE_GIT_MESSAGE));
		const api = buildConfigApi();

		await expect(
			api.saveConfig({ workspaceId: WORKSPACE_ID, workspacePath: "/tmp/project" }, { worktreesEnabled: true }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: WORKTREES_REQUIRE_GIT_MESSAGE,
		});
	});

	it("maps a generic persistence failure to an INTERNAL_SERVER_ERROR TRPCError (Req 14.5)", async () => {
		runtimeConfigMocks.updateRuntimeConfig.mockRejectedValue(new Error("disk full"));
		const api = buildConfigApi();

		let caught: unknown;
		try {
			await api.saveConfig({ workspaceId: WORKSPACE_ID, workspacePath: "/tmp/project" }, { worktreesEnabled: true });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(TRPCError);
		expect(caught).toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: "disk full" });
	});
});
