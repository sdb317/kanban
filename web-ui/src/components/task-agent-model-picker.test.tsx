import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UseTaskAgentModelPickerResult } from "@/components/task-agent-model-picker";
import type {
    RuntimeAgentId,
    RuntimeClineProviderCatalogItem,
    RuntimeClineProviderModel,
    RuntimeTaskClineSettings,
} from "@/runtime/types";

const fetchClineProviderCatalogMock = vi.hoisted(() => vi.fn());
const fetchClineProviderModelsMock = vi.hoisted(() => vi.fn());

vi.mock("@runtime-agent-catalog", () => ({
	getRuntimeLaunchSupportedAgentCatalog: vi.fn(() => [
		{ id: "cline", label: "Cline", binary: "cline" },
		{ id: "claude", label: "Claude Code", binary: "claude" },
	]),
}));

vi.mock("@/runtime/runtime-config-query", () => ({
	fetchClineProviderCatalog: fetchClineProviderCatalogMock,
	fetchClineProviderModels: fetchClineProviderModelsMock,
}));

function createProvider(
	id: string,
	name: string,
	enabled: boolean,
	defaultModelId: string | null = null,
): RuntimeClineProviderCatalogItem {
	return { id, name, oauthSupported: false, enabled, defaultModelId, baseUrl: null, supportsBaseUrl: false };
}

function createTaskClineSettings(settings?: RuntimeTaskClineSettings): RuntimeTaskClineSettings | undefined {
	return settings;
}

let container: HTMLDivElement;
let root: Root;
let previousActEnvironment: boolean | undefined;

beforeEach(() => {
	previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
		.IS_REACT_ACT_ENVIRONMENT;
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
	if (previousActEnvironment === undefined) {
		delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	} else {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	}
});

describe("useTaskAgentModelPicker – clineProviderOptions", () => {
	it("shows all providers except the default, regardless of enabled flag", async () => {
		const catalog: RuntimeClineProviderCatalogItem[] = [
			createProvider("cline", "Cline", true),
			createProvider("openrouter", "OpenRouter", false),
			createProvider("anthropic", "Anthropic", false),
		];
		fetchClineProviderCatalogMock.mockResolvedValue(catalog);
		fetchClineProviderModelsMock.mockResolvedValue([]);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "cline",
				clineSettings: undefined,
				defaultAgentId: "cline",
				defaultProviderId: "cline",
				defaultModelId: null,
			});
			useEffect(() => {
				snapshot = result;
			});
			return null;
		}

		await act(async () => root.render(<Harness />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(snapshot).not.toBeNull();
		const options = snapshot!.clineProviderOptions;
		expect(options[0]).toEqual({ value: "", label: "Cline" });
		const nonDefault = options.slice(1);
		expect(nonDefault).toEqual([
			{ value: "openrouter", label: "OpenRouter" },
			{ value: "anthropic", label: "Anthropic" },
		]);
	});
	it("excludes the default provider from the explicit list", async () => {
		const catalog: RuntimeClineProviderCatalogItem[] = [
			createProvider("cline", "Cline", true),
			createProvider("anthropic", "Anthropic", true),
		];
		fetchClineProviderCatalogMock.mockResolvedValue(catalog);
		fetchClineProviderModelsMock.mockResolvedValue([]);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "cline",
				clineSettings: undefined,
				defaultAgentId: "cline",
				defaultProviderId: "anthropic",
				defaultModelId: null,
			});
			useEffect(() => {
				snapshot = result;
			});
			return null;
		}

		await act(async () => root.render(<Harness />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(snapshot).not.toBeNull();
		const options = snapshot!.clineProviderOptions;
		expect(options[0]).toEqual({ value: "", label: "Anthropic" });
		const values = options.slice(1).map((o) => o.value);
		expect(values).toContain("cline");
		expect(values).not.toContain("anthropic");
	});

	it("returns only the default option when catalog is empty", async () => {
		fetchClineProviderCatalogMock.mockResolvedValue([]);
		fetchClineProviderModelsMock.mockResolvedValue([]);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "cline",
				clineSettings: undefined,
				defaultAgentId: "cline",
				defaultProviderId: "cline",
				defaultModelId: null,
			});
			useEffect(() => {
				snapshot = result;
			});
			return null;
		}

		await act(async () => root.render(<Harness />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(snapshot).not.toBeNull();
		expect(snapshot!.clineProviderOptions).toEqual([{ value: "", label: "cline" }]);
	});
});

describe("useTaskAgentModelPicker – providerDefaultModels", () => {
	it("returns a map of provider ID → default model ID", async () => {
		const catalog: RuntimeClineProviderCatalogItem[] = [
			createProvider("anthropic", "Anthropic", true, "claude-opus-4-20250514"),
			createProvider("groq", "Groq", true, "llama-3.3-70b-versatile"),
			createProvider("openrouter", "OpenRouter", true), // no default model
		];
		fetchClineProviderCatalogMock.mockResolvedValue(catalog);
		fetchClineProviderModelsMock.mockResolvedValue([]);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "cline",
				clineSettings: undefined,
				defaultAgentId: "cline",
				defaultProviderId: "anthropic",
				defaultModelId: "claude-opus-4-20250514",
			});
			useEffect(() => {
				snapshot = result;
			});
			return null;
		}

		await act(async () => root.render(<Harness />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(snapshot).not.toBeNull();
		expect(snapshot!.providerDefaultModels).toEqual({
			anthropic: "claude-opus-4-20250514",
			groq: "llama-3.3-70b-versatile",
		});
	});
});

describe("useTaskAgentModelPicker – provider-aware model default label", () => {
	it("loads inherited models for managed OAuth providers and derives their catalog default model", async () => {
		const catalog: RuntimeClineProviderCatalogItem[] = [
			createProvider("cline", "Cline", true, "cline-sonnet"),
			createProvider("anthropic", "Anthropic", true, "claude-opus-4-20250514"),
		];
		const clineModels = [
			{ id: "cline-sonnet", name: "Cline Sonnet" },
			{ id: "cline-opus", name: "Cline Opus" },
		];
		fetchClineProviderCatalogMock.mockResolvedValue(catalog);
		fetchClineProviderModelsMock.mockResolvedValue(clineModels);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "cline",
				clineSettings: undefined,
				defaultAgentId: "cline",
				defaultProviderId: "cline",
				defaultModelId: null,
			});
			useEffect(() => {
				snapshot = result;
			});
			return null;
		}

		await act(async () => root.render(<Harness />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(fetchClineProviderModelsMock).toHaveBeenCalledWith(null, "cline");
		expect(snapshot).not.toBeNull();
		expect(snapshot!.providerModels).toEqual(clineModels);
		expect(snapshot!.effectiveDefaultModelId).toBe("cline-sonnet");
	});

	it("does not borrow the global default model for an overridden provider without a catalog default", async () => {
		const catalog: RuntimeClineProviderCatalogItem[] = [
			createProvider("anthropic", "Anthropic", true, "claude-opus-4-20250514"),
			createProvider("custom", "Custom Provider", true),
		];
		const customModels = [{ id: "custom/model-a", name: "Model A" }];
		fetchClineProviderCatalogMock.mockResolvedValue(catalog);
		fetchClineProviderModelsMock.mockResolvedValue(customModels);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "cline",
				clineSettings: createTaskClineSettings({ providerId: "custom" }),
				defaultAgentId: "cline",
				defaultProviderId: "anthropic",
				defaultModelId: "claude-opus-4-20250514",
			});
			useEffect(() => {
				snapshot = result;
			});
			return null;
		}

		await act(async () => root.render(<Harness />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(snapshot).not.toBeNull();
		expect(snapshot!.effectiveDefaultModelId).toBeNull();
		expect(snapshot!.clineModelOptions[0]).toEqual({ value: "", label: "Default" });
	});

	it("shows the selected provider's default model name when provider is overridden", async () => {
		const catalog: RuntimeClineProviderCatalogItem[] = [
			createProvider("anthropic", "Anthropic", true, "claude-opus-4-20250514"),
			createProvider("groq", "Groq", true, "llama-3.3-70b-versatile"),
		];
		const groqModels = [
			{ id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B" },
			{ id: "mixtral-8x7b-32768", name: "Mixtral 8x7B" },
		];
		fetchClineProviderCatalogMock.mockResolvedValue(catalog);
		fetchClineProviderModelsMock.mockResolvedValue(groqModels);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "cline",
				clineSettings: createTaskClineSettings({ providerId: "groq" }), // explicit provider override to groq
				defaultAgentId: "cline",
				defaultProviderId: "anthropic",
				defaultModelId: "claude-opus-4-20250514", // global default is Anthropic's model
			});
			useEffect(() => {
				snapshot = result;
			});
			return null;
		}

		await act(async () => root.render(<Harness />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(snapshot).not.toBeNull();
		// The first model option should show groq's default model, not the global Anthropic model
		const defaultOption = snapshot!.clineModelOptions[0]!;
		expect(defaultOption.value).toBe("");
		expect(defaultOption.label).toBe("Llama 3.3 70B");
	});

	it("shows the global default model when no provider override is set", async () => {
		const catalog: RuntimeClineProviderCatalogItem[] = [
			createProvider("anthropic", "Anthropic", true, "claude-opus-4-20250514"),
			createProvider("groq", "Groq", true, "llama-3.3-70b-versatile"),
		];
		const anthropicModels = [
			{ id: "claude-opus-4-20250514", name: "Claude Opus 4" },
			{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
		];
		fetchClineProviderCatalogMock.mockResolvedValue(catalog);
		fetchClineProviderModelsMock.mockResolvedValue(anthropicModels);

		let snapshot: UseTaskAgentModelPickerResult | null = null;
		const { useTaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		function Harness() {
			const result = useTaskAgentModelPicker({
				active: true,
				workspaceId: null,
				agentId: "cline",
				clineSettings: undefined, // no provider override
				defaultAgentId: "cline",
				defaultProviderId: "anthropic",
				defaultModelId: "claude-opus-4-20250514",
			});
			useEffect(() => {
				snapshot = result;
			});
			return null;
		}

		await act(async () => root.render(<Harness />));
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(snapshot).not.toBeNull();
		const defaultOption = snapshot!.clineModelOptions[0]!;
		expect(defaultOption.value).toBe("");
		expect(defaultOption.label).toBe("Claude Opus 4");
	});
});

describe("TaskAgentModelPicker – auto-reset invalid model selection", () => {
	it("resets clineModelId to the first real model when the selected model is not in the options list", async () => {
		const onClineSettingsChange = vi.fn();
		const modelOptions = [
			{ value: "", label: "Llama 3.3 70B" },
			{ value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
			{ value: "mixtral-8x7b-32768", label: "Mixtral 8x7B" },
		];

		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			root.render(
				<TaskAgentModelPicker
					agentId={"cline" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					clineSettings={createTaskClineSettings({
						providerId: "groq",
						modelId: "claude-opus-4-20250514",
					})}
					onClineSettingsChange={onClineSettingsChange}
					agentOptions={[{ value: "", label: "Cline" }]}
					clineProviderOptions={[{ value: "", label: "Anthropic" }]}
					clineModelOptions={modelOptions}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="anthropic"
				/>,
			),
		);

		// The effect should have fired and selected the first real model
		expect(onClineSettingsChange).toHaveBeenCalledWith({
			providerId: "groq",
			modelId: "llama-3.3-70b-versatile",
		});
	});

	it("does not reset when the selected model exists in the options list", async () => {
		const onClineSettingsChange = vi.fn();
		const modelOptions = [
			{ value: "", label: "Llama 3.3 70B" },
			{ value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
			{ value: "mixtral-8x7b-32768", label: "Mixtral 8x7B" },
		];

		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			root.render(
				<TaskAgentModelPicker
					agentId={"cline" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					clineSettings={createTaskClineSettings({
						providerId: "groq",
						modelId: "llama-3.3-70b-versatile",
					})}
					onClineSettingsChange={onClineSettingsChange}
					agentOptions={[{ value: "", label: "Cline" }]}
					clineProviderOptions={[{ value: "", label: "Groq" }]}
					clineModelOptions={modelOptions}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="anthropic"
				/>,
			),
		);

		expect(onClineSettingsChange).not.toHaveBeenCalled();
	});

	it("does not reset while models are still loading", async () => {
		const onClineSettingsChange = vi.fn();
		const modelOptions = [{ value: "", label: "Default" }];

		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			root.render(
				<TaskAgentModelPicker
					agentId={"cline" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					clineSettings={createTaskClineSettings({
						providerId: "groq",
						modelId: "claude-opus-4-20250514",
					})}
					onClineSettingsChange={onClineSettingsChange}
					agentOptions={[{ value: "", label: "Cline" }]}
					clineProviderOptions={[{ value: "", label: "Anthropic" }]}
					clineModelOptions={modelOptions}
					isLoadingProviders={false}
					isLoadingModels={true} // <-- still loading
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="anthropic"
				/>,
			),
		);

		expect(onClineSettingsChange).not.toHaveBeenCalled();
	});

	it("does not reset when model options only contain the default placeholder (race condition guard)", async () => {
		const onClineSettingsChange = vi.fn();
		// Only the "Default" placeholder — real models haven't loaded yet
		const modelOptions = [{ value: "", label: "Default" }];

		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			root.render(
				<TaskAgentModelPicker
					agentId={"cline" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					clineSettings={createTaskClineSettings({
						providerId: "groq",
						modelId: "mixtral-8x7b-32768",
					})}
					onClineSettingsChange={onClineSettingsChange}
					agentOptions={[{ value: "", label: "Cline" }]}
					clineProviderOptions={[{ value: "", label: "Groq" }]}
					clineModelOptions={modelOptions}
					isLoadingProviders={false}
					isLoadingModels={false} // <-- false (initial state before fetch sets it to true)
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="anthropic"
				/>,
			),
		);

		// Should NOT clear the model — the stale/empty options list should not trigger auto-correct
		expect(onClineSettingsChange).not.toHaveBeenCalled();
	});
});

describe("TaskAgentModelPicker – inherited default reasoning effort", () => {
	it("shows reasoning metadata for an inherited default model and opens reasoning choices immediately", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			root.render(
				<TaskAgentModelPicker
					agentId={"cline" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					clineSettings={undefined}
					onClineSettingsChange={() => {}}
					agentOptions={[{ value: "", label: "Cline" }]}
					clineProviderOptions={[{ value: "", label: "Cline" }]}
					clineModelOptions={[
						{ value: "", label: "GPT-5.4" },
						{ value: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" },
					]}
					effectiveDefaultModelId="openai/gpt-5.4"
					providerModels={[
						{ id: "openai/gpt-5.4", name: "GPT-5.4", supportsReasoningEffort: true },
						{ id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex", supportsReasoningEffort: true },
					]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="cline"
					defaultReasoningEffort="high"
				/>,
			),
		);

		const settingsTrigger = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Override Agent Settings"),
		);
		expect(settingsTrigger).not.toBeUndefined();
		await act(async () => {
			(settingsTrigger as HTMLButtonElement).click();
		});

		expect(container.textContent).toContain("GPT-5.4 (High)");

		const trigger = document.getElementById("cline-chat-model-picker");
		expect(trigger).not.toBeNull();
		await act(async () => {
			(trigger as HTMLElement).click();
		});

		expect(document.body.textContent).toContain("Reasoning effort");
	});

	it("retains inherited reasoning effort until model capability data is available", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		const renderPicker = async (providerModels: RuntimeClineProviderModel[]) => {
			await act(async () =>
				root.render(
					<TaskAgentModelPicker
						agentId={"cline" as RuntimeAgentId}
						onAgentIdChange={() => {}}
						clineSettings={undefined}
						onClineSettingsChange={() => {}}
						agentOptions={[{ value: "", label: "Cline" }]}
						clineProviderOptions={[{ value: "", label: "Cline" }]}
						clineModelOptions={[
							{ value: "", label: "GPT-5.4" },
							{ value: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" },
						]}
						effectiveDefaultModelId="openai/gpt-5.4"
						providerModels={providerModels}
						isLoadingProviders={false}
						isLoadingModels={false}
						defaultAgentId={"cline" as RuntimeAgentId}
						defaultProviderId="cline"
						defaultReasoningEffort="high"
					/>,
				),
			);
		};

		await renderPicker([]);

		const settingsTrigger = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Override Agent Settings"),
		);
		expect(settingsTrigger).not.toBeUndefined();
		await act(async () => {
			(settingsTrigger as HTMLButtonElement).click();
		});

		await renderPicker([
			{ id: "openai/gpt-5.4", name: "GPT-5.4", supportsReasoningEffort: true },
			{ id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex", supportsReasoningEffort: true },
		]);

		expect(container.textContent).toContain("GPT-5.4 (High)");
	});

	it("persists a reasoning-only override when model stays on default", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");
		const onClineSettingsChange = vi.fn();

		await act(async () =>
			root.render(
				<TaskAgentModelPicker
					agentId={"cline" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					clineSettings={undefined}
					onClineSettingsChange={onClineSettingsChange}
					agentOptions={[{ value: "", label: "Cline" }]}
					clineProviderOptions={[{ value: "", label: "Cline" }]}
					clineModelOptions={[
						{ value: "", label: "GPT-5.4" },
						{ value: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" },
					]}
					effectiveDefaultModelId="openai/gpt-5.4"
					providerModels={[
						{ id: "openai/gpt-5.4", name: "GPT-5.4", supportsReasoningEffort: true },
						{ id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex", supportsReasoningEffort: true },
					]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="cline"
					defaultReasoningEffort="high"
				/>,
			),
		);

		const settingsTrigger = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Override Agent Settings"),
		);
		expect(settingsTrigger).not.toBeUndefined();
		await act(async () => {
			(settingsTrigger as HTMLButtonElement).click();
		});

		const modelTrigger = document.getElementById("cline-chat-model-picker");
		expect(modelTrigger).not.toBeNull();
		await act(async () => {
			(modelTrigger as HTMLElement).click();
		});

		const lowReasoningButton = Array.from(document.querySelectorAll("button")).find((button) =>
			button.textContent?.trim().toLowerCase().startsWith("low"),
		);
		expect(lowReasoningButton).not.toBeUndefined();
		await act(async () => {
			(lowReasoningButton as HTMLButtonElement).click();
		});

		expect(onClineSettingsChange).toHaveBeenLastCalledWith({
			reasoningEffort: "low",
		});
	});

	it("persists an explicit default reasoning override when the task inherits a global reasoning effort", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");
		const onClineSettingsChange = vi.fn();

		await act(async () =>
			root.render(
				<TaskAgentModelPicker
					agentId={"cline" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					clineSettings={undefined}
					onClineSettingsChange={onClineSettingsChange}
					agentOptions={[{ value: "", label: "Cline" }]}
					clineProviderOptions={[{ value: "", label: "Cline" }]}
					clineModelOptions={[{ value: "", label: "GPT-5.4" }]}
					effectiveDefaultModelId="openai/gpt-5.4"
					providerModels={[{ id: "openai/gpt-5.4", name: "GPT-5.4", supportsReasoningEffort: true }]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="cline"
					defaultReasoningEffort="high"
				/>,
			),
		);

		const settingsTrigger = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Override Agent Settings"),
		);
		expect(settingsTrigger).not.toBeUndefined();
		await act(async () => {
			(settingsTrigger as HTMLButtonElement).click();
		});

		const modelTrigger = document.getElementById("cline-chat-model-picker");
		expect(modelTrigger).not.toBeNull();
		await act(async () => {
			(modelTrigger as HTMLElement).click();
		});

		const defaultReasoningButton = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Default",
		);
		expect(defaultReasoningButton).not.toBeUndefined();
		await act(async () => {
			(defaultReasoningButton as HTMLButtonElement).click();
		});

		expect(onClineSettingsChange).toHaveBeenLastCalledWith({});
	});

	it("does not inherit the global reasoning effort for explicit task model overrides", async () => {
		const { TaskAgentModelPicker } = await import("@/components/task-agent-model-picker");

		await act(async () =>
			root.render(
				<TaskAgentModelPicker
					agentId={"cline" as RuntimeAgentId}
					onAgentIdChange={() => {}}
					clineSettings={createTaskClineSettings({
						modelId: "openai/gpt-5.3-codex",
					})}
					onClineSettingsChange={() => {}}
					agentOptions={[{ value: "", label: "Cline" }]}
					clineProviderOptions={[{ value: "", label: "Cline" }]}
					clineModelOptions={[
						{ value: "", label: "GPT-5.4" },
						{ value: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" },
					]}
					effectiveDefaultModelId="openai/gpt-5.4"
					providerModels={[
						{ id: "openai/gpt-5.4", name: "GPT-5.4", supportsReasoningEffort: true },
						{ id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex", supportsReasoningEffort: true },
					]}
					isLoadingProviders={false}
					isLoadingModels={false}
					defaultAgentId={"cline" as RuntimeAgentId}
					defaultProviderId="cline"
					defaultReasoningEffort="high"
				/>,
			),
		);

		const settingsTrigger = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Override Agent Settings"),
		);
		expect(settingsTrigger).not.toBeUndefined();
		await act(async () => {
			(settingsTrigger as HTMLButtonElement).click();
		});

		expect(container.textContent).toContain("GPT-5.3 Codex");
		expect(container.textContent).not.toContain("GPT-5.3 Codex (High)");
	});
});

describe("TaskAgentModelPicker – Ollama model selection", () => {
	// A controlled harness that mirrors App.tsx: it owns clineSettings state and
	// feeds every onClineSettingsChange back into the picker. This is required to
	// exercise the auto-reset effect, which reacts to the stored modelId.
	function OllamaPickerHarness({
		onSettings,
		clineModelOptions,
		providerModels,
		initialSettings,
	}: {
		onSettings: (next: RuntimeTaskClineSettings | undefined) => void;
		clineModelOptions: Array<{ value: string; label: string }>;
		providerModels: RuntimeClineProviderModel[];
		initialSettings: RuntimeTaskClineSettings | undefined;
	}) {
		const [clineSettings, setClineSettings] = useState<RuntimeTaskClineSettings | undefined>(initialSettings);
		const { TaskAgentModelPicker } = TaskAgentModelPickerModule;
		return (
			<TaskAgentModelPicker
				agentId={"cline" as RuntimeAgentId}
				onAgentIdChange={() => {}}
				clineSettings={clineSettings}
				onClineSettingsChange={(next) => {
					setClineSettings(next);
					onSettings(next);
				}}
				agentOptions={[{ value: "", label: "Cline" }]}
				clineProviderOptions={[
					{ value: "", label: "Ollama" },
					{ value: "cline", label: "Cline" },
				]}
				clineModelOptions={clineModelOptions}
				effectiveDefaultModelId="gemma4:e4b"
				providerModels={providerModels}
				isLoadingProviders={false}
				isLoadingModels={false}
				defaultAgentId={"cline" as RuntimeAgentId}
				defaultProviderId="ollama"
				providerDefaultModels={{ ollama: "gemma4:e4b" }}
			/>
		);
	}

	let TaskAgentModelPickerModule: typeof import("@/components/task-agent-model-picker");

	beforeEach(async () => {
		TaskAgentModelPickerModule = await import("@/components/task-agent-model-picker");
	});

	// Options list intentionally omits the provider's default model (gemma4:e4b);
	// it is represented by the "" placeholder.
	const clineModelOptions = [
		{ value: "", label: "gemma4:e4b" },
		{ value: "llama3.3:70b", label: "llama3.3:70b" },
		{ value: "qwen2.5-coder:32b", label: "qwen2.5-coder:32b" },
	];
	const providerModels = [
		{ id: "gemma4:e4b", name: "gemma4:e4b" },
		{ id: "llama3.3:70b", name: "llama3.3:70b" },
		{ id: "qwen2.5-coder:32b", name: "qwen2.5-coder:32b" },
	];

	async function openModelPicker() {
		const settingsTrigger = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Override Agent Settings"),
		);
		expect(settingsTrigger).not.toBeUndefined();
		await act(async () => {
			(settingsTrigger as HTMLButtonElement).click();
		});
		const modelTrigger = document.getElementById("cline-chat-model-picker");
		expect(modelTrigger).not.toBeNull();
		await act(async () => {
			(modelTrigger as HTMLElement).click();
		});
	}

	// Select a model via the search box + Enter key. This mirrors keyboard use and
	// avoids the jsdom quirk where a pointer click that closes one Radix popover
	// can bubble to another popover's trigger (which never happens in a browser).
	async function selectModelByTyping(query: string) {
		const modelSearchInput = document.querySelector(
			'input[placeholder="Search models..."]',
		) as HTMLInputElement | null;
		expect(modelSearchInput, "model search input should be present").not.toBeNull();
		await act(async () => {
			const input = modelSearchInput as HTMLInputElement;
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, query);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			(modelSearchInput as HTMLInputElement).dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
		});
	}

	// Reproduces the reported bug: with Ollama as the provider and its default
	// model (gemma4:e4b) stored in modelId, selecting a different model must stick.
	// Previously, choosing a model that does not support reasoning effort fired a
	// second settings update (clearing reasoning effort) that read the stale
	// render-time settings and reverted modelId back to the provider default.
	it("keeps a non-default Ollama model selected after choosing it", async () => {
		const settingsCalls: Array<RuntimeTaskClineSettings | undefined> = [];

		await act(async () =>
			root.render(
				<OllamaPickerHarness
					onSettings={(next) => settingsCalls.push(next)}
					clineModelOptions={clineModelOptions}
					providerModels={providerModels}
					// Simulate selecting the Ollama provider, which stores its default model id.
					initialSettings={{ providerId: "ollama", modelId: "gemma4:e4b" }}
				/>,
			),
		);

		// Let the auto-reset effect settle after the initial render.
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		settingsCalls.length = 0;
		await openModelPicker();
		await selectModelByTyping("qwen2.5-coder:32b");

		// Let any follow-up effects run.
		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(settingsCalls.at(-1)).toEqual({ providerId: "ollama", modelId: "qwen2.5-coder:32b" });
	});

	// Storing the provider default model id must not be auto-reset to a different
	// model just because the default is absent from the explicit options list.
	it("does not auto-reset when modelId equals the provider default model", async () => {
		const settingsCalls: Array<RuntimeTaskClineSettings | undefined> = [];

		await act(async () =>
			root.render(
				<OllamaPickerHarness
					onSettings={(next) => settingsCalls.push(next)}
					clineModelOptions={clineModelOptions}
					providerModels={providerModels}
					initialSettings={{ providerId: "ollama", modelId: "gemma4:e4b" }}
				/>,
			),
		);

		await act(async () => {
			await new Promise((r) => setTimeout(r, 0));
		});

		// The auto-reset effect must not have rewritten the stored default model.
		expect(settingsCalls.some((call) => call?.modelId && call.modelId !== "gemma4:e4b")).toBe(false);
	});
});
