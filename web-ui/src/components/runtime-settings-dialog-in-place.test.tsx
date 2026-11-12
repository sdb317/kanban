// Feature: in-place-workspace-mode, task 16.2 — settings dialog In-Place example tests.
// Covers the "Use git worktrees" toggle and per-project override radio group,
// the minimal save request, cancel discarding drafts, a save failure keeping the
// dialog open with the runtime error, and the hidden commit/PR prompt template
// editor in In-Place Mode.
import type { ReactNode } from "react";
import { act, createContext, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeSettingsDialog } from "@/components/runtime-settings-dialog";
import type { RuntimeConfigResponse, RuntimeConfigSaveRequest } from "@/runtime/types";
import { WorktreeModeProvider } from "@/runtime/worktree-mode";

type RuntimeConfigSaveResult = { ok: true; config: RuntimeConfigResponse } | { ok: false; error: unknown };

/*
 * Radix Select depends on pointer-capture APIs jsdom lacks. Replace it with a
 * minimal native stand-in so the dialog renders without fighting jsdom. The
 * In-Place tests here never interact with the theme picker, but the component
 * still mounts it.
 */
const RadixSelectCtx = createContext<{
	value: string;
	onValueChange: (v: string) => void;
}>({ value: "", onValueChange: () => {} });

vi.mock("@radix-ui/react-select", () => ({
	Root: ({
		value,
		onValueChange,
		children,
	}: {
		value: string;
		onValueChange: (v: string) => void;
		children: ReactNode;
	}) => (
		<RadixSelectCtx.Provider value={{ value, onValueChange }}>
			<div data-radix-select-root="">{typeof children === "function" ? null : children}</div>
		</RadixSelectCtx.Provider>
	),
	Trigger: ({ children, ...props }: { children: ReactNode; "aria-label"?: string }) => (
		<button type="button" {...props} data-radix-select-trigger="">
			{children}
		</button>
	),
	Value: ({ placeholder }: { placeholder?: string }) => {
		const ctx = useContext(RadixSelectCtx);
		return <span>{ctx.value || placeholder}</span>;
	},
	Icon: ({ children }: { children: ReactNode }) => <span>{children}</span>,
	Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
	Content: ({ children }: { children: ReactNode }) => <div data-radix-select-content="">{children}</div>,
	ScrollUpButton: () => null,
	ScrollDownButton: () => null,
	Viewport: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	Group: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	Label: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	Separator: () => <hr />,
	Item: ({ value, children, ...rest }: { value: string; children: ReactNode }) => {
		const ctx = useContext(RadixSelectCtx);
		return (
			<button type="button" role="option" aria-label={value} onClick={() => ctx.onValueChange(value)} {...rest}>
				{children}
			</button>
		);
	},
	ItemText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
	ItemIndicator: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

const resetLayoutCustomizationsMock = vi.hoisted(() => vi.fn());
const saveMock = vi.hoisted(() =>
	vi.fn(
		async (_request: RuntimeConfigSaveRequest): Promise<RuntimeConfigSaveResult> => ({
			ok: true,
			config: null as unknown as RuntimeConfigResponse,
		}),
	),
);

vi.mock("@runtime-agent-catalog", () => ({
	getRuntimeAgentCatalogEntry: vi.fn((agentId: string) => ({
		id: agentId,
		installUrl: null,
		autonomousArgs: [],
	})),
	getRuntimeLaunchSupportedAgentCatalog: vi.fn(() => [{ id: "claude", label: "Claude Code", binary: "claude" }]),
}));

vi.mock("@runtime-shortcuts", () => ({
	areRuntimeProjectShortcutsEqual: vi.fn(() => true),
}));

vi.mock("@/components/shared/cline-setup-section", () => ({
	ClineSetupSection: () => null,
}));

vi.mock("@/hooks/use-runtime-settings-cline-controller", () => ({
	useRuntimeSettingsClineController: () => ({
		currentProviderSettings: null,
		hasUnsavedChanges: false,
		providerId: "anthropic",
		saveProviderSettings: vi.fn(async () => ({ ok: true })),
	}),
}));

vi.mock("@/hooks/use-runtime-settings-cline-mcp-controller", () => ({
	useRuntimeSettingsClineMcpController: () => ({
		hasUnsavedChanges: false,
		saveMcpSettings: vi.fn(async () => ({ ok: true })),
	}),
}));

vi.mock("@/resize/layout-customizations", () => ({
	useLayoutCustomizations: () => ({
		layoutResetNonce: 0,
		resetLayoutCustomizations: resetLayoutCustomizationsMock,
	}),
}));

vi.mock("@/runtime/use-runtime-config", () => ({
	useRuntimeConfig: (_open: boolean, _workspaceId: string | null, initialConfig?: RuntimeConfigResponse | null) => ({
		config: initialConfig ?? null,
		isLoading: false,
		isSaving: false,
		refresh: vi.fn(),
		save: saveMock,
	}),
}));

vi.mock("@/runtime/runtime-config-query", () => ({
	openFileOnHost: vi.fn(async () => undefined),
}));

vi.mock("@/utils/notification-permission", () => ({
	getBrowserNotificationPermission: () => "unsupported",
	requestBrowserNotificationPermission: vi.fn(async () => "unsupported"),
}));

function findButtonByText(container: ParentNode, text: string): HTMLButtonElement | null {
	return (Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) ??
		null) as HTMLButtonElement | null;
}

function findSwitchByLabel(label: string): HTMLButtonElement | null {
	const span = Array.from(document.body.querySelectorAll("span")).find((node) => node.textContent?.trim() === label);
	const row = span?.parentElement ?? null;
	return (row?.querySelector('button[role="switch"]') ?? null) as HTMLButtonElement | null;
}

function findRadioByLabel(label: string): HTMLButtonElement | null {
	const span = Array.from(document.body.querySelectorAll("span")).find((node) => node.textContent?.trim() === label);
	const labelEl = span?.closest("label") ?? null;
	return (labelEl?.querySelector('button[role="radio"]') ?? null) as HTMLButtonElement | null;
}

const BASE_CONFIG = {
	selectedAgentId: "claude",
	selectedShortcutLabel: null,
	agentAutonomousModeEnabled: true,
	readyForReviewNotificationsEnabled: false,
	effectiveCommand: "claude",
	detectedCommands: [],
	shortcuts: [],
	commitPromptTemplate: "COMMIT TEMPLATE TEXT",
	openPrPromptTemplate: "PR TEMPLATE TEXT",
	commitPromptTemplateDefault: "",
	openPrPromptTemplateDefault: "",
	globalConfigPath: "/home/user/.kanban/config.json",
	projectConfigPath: "/project/.kanban/config.json",
	globalWorktreesEnabled: false,
	projectWorktreesEnabled: null,
	worktreesEnabled: false,
	agents: [{ id: "claude", label: "Claude Code", binary: "claude", command: "claude", installed: true }],
	clineProviderSettings: null,
} as unknown as RuntimeConfigResponse;

describe("RuntimeSettingsDialog In-Place Mode", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		resetLayoutCustomizationsMock.mockReset();
		saveMock.mockReset();
		saveMock.mockResolvedValue({ ok: true, config: null as unknown as RuntimeConfigResponse });
		window.localStorage.clear();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		document.body.innerHTML = "";
		window.localStorage.clear();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	async function renderDialog(
		config: RuntimeConfigResponse,
		handlers: { onOpenChange?: (open: boolean) => void } = {},
	): Promise<void> {
		await act(async () => {
			root.render(
				<WorktreeModeProvider value={false}>
					<RuntimeSettingsDialog
						open={true}
						workspaceId="workspace-1"
						initialConfig={config}
						onOpenChange={handlers.onOpenChange ?? (() => {})}
					/>
				</WorktreeModeProvider>,
			);
		});
	}

	it("renders the worktrees toggle off and the project override radio group", async () => {
		await renderDialog(BASE_CONFIG);

		const worktreesSwitch = findSwitchByLabel("Use git worktrees");
		expect(worktreesSwitch).toBeInstanceOf(HTMLButtonElement);
		expect(worktreesSwitch?.getAttribute("data-state")).toBe("unchecked");

		// All three override options are present; "Use global default" is selected.
		const globalRadio = findRadioByLabel("Use global default");
		const offRadio = findRadioByLabel("Off (in-place)");
		const onRadio = findRadioByLabel("On (worktrees)");
		expect(globalRadio).toBeInstanceOf(HTMLButtonElement);
		expect(offRadio).toBeInstanceOf(HTMLButtonElement);
		expect(onRadio).toBeInstanceOf(HTMLButtonElement);
		expect(globalRadio?.getAttribute("data-state")).toBe("checked");
	});

	it("hides the commit/PR prompt template editor while the effective setting is false", async () => {
		await renderDialog(BASE_CONFIG);

		// The Git Prompts nav item and section are not rendered in In-Place Mode.
		expect(findButtonByText(document.body, "Git Prompts")).toBeNull();
		expect(document.body.textContent).not.toContain(
			"Modify the prompts sent to the agent when using Commit or Make PR",
		);
		// The template textarea with the loaded commit template is not mounted.
		const textareas = Array.from(document.body.querySelectorAll("textarea"));
		expect(textareas.some((node) => node.value === "COMMIT TEMPLATE TEXT")).toBe(false);
	});

	it("sends only the changed worktree field and the unchanged loaded templates on save", async () => {
		await renderDialog(BASE_CONFIG);

		const worktreesSwitch = findSwitchByLabel("Use git worktrees");
		expect(worktreesSwitch).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			worktreesSwitch?.click();
		});

		const saveButton = findButtonByText(document.body, "Save");
		expect(saveButton?.disabled).toBe(false);

		await act(async () => {
			saveButton?.click();
		});

		expect(saveMock).toHaveBeenCalledTimes(1);
		const request = saveMock.mock.calls[0]?.[0] as RuntimeConfigSaveRequest;
		// Only the global flag flipped; the project override stays unset.
		expect(request.worktreesEnabled).toBe(true);
		expect(request).not.toHaveProperty("projectWorktreesEnabled");
		// Loaded templates are sent unchanged even though their editors are hidden.
		expect(request.commitPromptTemplate).toBe("COMMIT TEMPLATE TEXT");
		expect(request.openPrPromptTemplate).toBe("PR TEMPLATE TEXT");
	});

	it("sends the project override when the radio selection changes", async () => {
		await renderDialog(BASE_CONFIG);

		const onRadio = findRadioByLabel("On (worktrees)");
		expect(onRadio).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			onRadio?.click();
		});

		const saveButton = findButtonByText(document.body, "Save");
		await act(async () => {
			saveButton?.click();
		});

		const request = saveMock.mock.calls[0]?.[0] as RuntimeConfigSaveRequest;
		expect(request.projectWorktreesEnabled).toBe(true);
		expect(request).not.toHaveProperty("worktreesEnabled");
	});

	it("discards worktree drafts and closes without saving on cancel", async () => {
		const onOpenChange = vi.fn();
		await renderDialog(BASE_CONFIG, { onOpenChange });

		const worktreesSwitch = findSwitchByLabel("Use git worktrees");
		await act(async () => {
			worktreesSwitch?.click();
		});
		expect(findSwitchByLabel("Use git worktrees")?.getAttribute("data-state")).toBe("checked");

		const cancelButton = findButtonByText(document.body, "Cancel");
		await act(async () => {
			cancelButton?.click();
		});

		expect(saveMock).not.toHaveBeenCalled();
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("keeps the dialog open and shows the runtime error when a save fails", async () => {
		saveMock.mockResolvedValueOnce({
			ok: false,
			error: new Error("Worktrees require a git repository."),
		});
		const onOpenChange = vi.fn();
		await renderDialog(BASE_CONFIG, { onOpenChange });

		const worktreesSwitch = findSwitchByLabel("Use git worktrees");
		await act(async () => {
			worktreesSwitch?.click();
		});

		const saveButton = findButtonByText(document.body, "Save");
		await act(async () => {
			saveButton?.click();
		});

		expect(saveMock).toHaveBeenCalledTimes(1);
		// The dialog stays open (onOpenChange not called with false) and surfaces the message.
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
		expect(document.body.textContent).toContain("Worktrees require a git repository.");
		// The Save button is still present, confirming the dialog did not close.
		expect(findButtonByText(document.body, "Save")).toBeInstanceOf(HTMLButtonElement);
	});

	it("shows the git prompt editor again when the project override forces worktrees on", async () => {
		await renderDialog(BASE_CONFIG);

		// Hidden to begin with (global false, no override).
		expect(findButtonByText(document.body, "Git Prompts")).toBeNull();

		const onRadio = findRadioByLabel("On (worktrees)");
		await act(async () => {
			onRadio?.click();
		});

		// Enabling the override makes the effective setting true, so the editor returns.
		expect(document.body.textContent).toContain("Modify the prompts sent to the agent when using Commit or Make PR");
	});
});
