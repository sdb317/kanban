import { describe, expect, it } from "vitest";

import { type RuntimeAgentId, runtimeAgentIdSchema } from "../../../src/core/api-contract";
import { renderAppendSystemPrompt } from "../../../src/prompts/append-system-prompt";

// Golden baseline of the Worktree Mode sidebar prompt, captured before any
// In-Place Workspace Mode changes. Property 18 (Worktree Mode prompts are
// unchanged) compares against these snapshots. Do not update them unless the
// Worktree Mode prompt is intentionally changed.
// Validates: Requirements 11.6, 15.2

const AGENT_IDS: readonly (RuntimeAgentId | null)[] = [...runtimeAgentIdSchema.options, null];

// Fixed command prefixes so output never depends on process.argv/execPath.
// Only the agent-specific Linear guidance varies by agent, so every agent is
// captured with the default prefix and the remaining prefixes are captured once.
const DEFAULT_PREFIX = "kanban";
const ALTERNATE_PREFIXES: readonly string[] = ["npx -y kanban", "pnpm dlx kanban", "node /opt/kanban/dist/cli.js"];

describe("renderAppendSystemPrompt golden snapshot", () => {
	for (const agentId of AGENT_IDS) {
		it(`prefix=${JSON.stringify(DEFAULT_PREFIX)} agent=${agentId ?? "null"}`, () => {
			expect(renderAppendSystemPrompt(DEFAULT_PREFIX, { agentId })).toMatchSnapshot();
		});
	}

	for (const commandPrefix of ALTERNATE_PREFIXES) {
		it(`prefix=${JSON.stringify(commandPrefix)} agent=claude`, () => {
			expect(renderAppendSystemPrompt(commandPrefix, { agentId: "claude" })).toMatchSnapshot();
		});
	}

	it("blank prefixes fall back to the default prefix", () => {
		const expected = renderAppendSystemPrompt(DEFAULT_PREFIX, { agentId: "claude" });
		expect(renderAppendSystemPrompt("", { agentId: "claude" })).toBe(expected);
		expect(renderAppendSystemPrompt("   ", { agentId: "claude" })).toBe(expected);
	});

	it("omitted options matches agentId null", () => {
		expect(renderAppendSystemPrompt(DEFAULT_PREFIX)).toBe(
			renderAppendSystemPrompt(DEFAULT_PREFIX, { agentId: null }),
		);
	});
});
