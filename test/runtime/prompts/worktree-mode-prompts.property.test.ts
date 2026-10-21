import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { type RuntimeAgentId, runtimeAgentIdSchema } from "../../../src/core/api-contract";
import { createHomeAgentSessionId, HOME_AGENT_SESSION_PREFIX } from "../../../src/core/home-agent-session";
import { renderAppendSystemPrompt } from "../../../src/prompts/append-system-prompt";
import { resolveAgentAppendSystemPrompt } from "../../../src/prompts/resolve-agent-append-prompt";

/**
 * Property 18: Worktree Mode prompts are unchanged.
 * Validates: Requirements 11.6
 *
 * In-Place Workspace Mode adds a `worktreesEnabled` switch to the prompt layer.
 * This suite pins the Worktree Mode (default) behavior so the new switch can
 * never silently alter it:
 *
 *   1. `renderAppendSystemPrompt` in Worktree Mode must match the 1.3 golden
 *      baseline. The byte-for-byte snapshot lives in
 *      `append-system-prompt-golden.test.ts`; here we assert the two paths that
 *      must resolve to that baseline are identical — passing
 *      `worktreesEnabled: true` explicitly is the same as omitting it (and the
 *      same as the pre-feature call shape) — and re-snapshot the default output
 *      so a Worktree Mode regression also fails in this property suite.
 *   2. `resolveAgentAppendSystemPrompt` returns `null` for non-home task
 *      sessions when `worktreesEnabled` is `true`, matching today's behavior of
 *      appending no prompt to Worktree Mode task agents.
 */

/** Every real agent id plus the `null` (unknown) agent. */
const AGENT_IDS: readonly (RuntimeAgentId | null)[] = [...runtimeAgentIdSchema.options, null];

/**
 * Representative command prefixes, matching the golden snapshot fixtures so the
 * property exercises the same interpolation shapes without depending on
 * `process.argv` / `process.execPath`.
 */
const COMMAND_PREFIXES: readonly string[] = [
	"kanban",
	"npx -y kanban",
	"pnpm dlx kanban",
	"yarn dlx kanban",
	"bun x kanban",
	"node /opt/kanban/dist/cli.js",
];

describe("Worktree Mode prompts are unchanged (Property 18)", () => {
	// Property 18: Worktree Mode prompts are unchanged.
	// Validates: Requirements 11.6
	it("renders the same prompt whether worktreesEnabled is true or omitted", () => {
		fc.assert(
			fc.property(fc.constantFrom(...AGENT_IDS), fc.constantFrom(...COMMAND_PREFIXES), (agentId, commandPrefix) => {
				const omitted = renderAppendSystemPrompt(commandPrefix, { agentId });
				const explicitTrue = renderAppendSystemPrompt(commandPrefix, { agentId, worktreesEnabled: true });

				// The `worktreesEnabled` default must be `true`: the explicit-true
				// output is byte-for-byte identical to omitting the option, which is
				// the call shape the golden snapshot captured.
				expect(explicitTrue).toBe(omitted);
			}),
			{ numRuns: 500 },
		);
	});

	it("matches the 1.3 golden baseline for the default (Worktree Mode) prompt", () => {
		// The golden snapshot in append-system-prompt-golden.test.ts is the
		// source of truth; this guards the same default-mode output here so a
		// Worktree Mode regression fails in this property suite too.
		for (const agentId of AGENT_IDS) {
			expect(renderAppendSystemPrompt("kanban", { agentId })).toMatchSnapshot(`agent=${agentId ?? "null"}`);
		}
	});

	it("resolveAgentAppendSystemPrompt returns null for non-home task sessions in Worktree Mode", () => {
		fc.assert(
			fc.property(
				fc.string({ minLength: 1 }).filter((id) => !id.startsWith(HOME_AGENT_SESSION_PREFIX)),
				fc.string({ minLength: 1 }),
				(taskId, projectPath) => {
					const resolved = resolveAgentAppendSystemPrompt({
						taskId,
						projectPath,
						worktreesEnabled: true,
					});
					expect(resolved).toBeNull();
				},
			),
			{ numRuns: 500 },
		);
	});

	it("resolveAgentAppendSystemPrompt still returns the Worktree Mode sidebar prompt for home sessions", () => {
		// Confirms the null result above is specific to non-home task sessions:
		// home sessions keep getting the Worktree Mode sidebar prompt. The command
		// prefix is derived from the runtime environment, so assert on the stable
		// Worktree Mode markers rather than a fixed prefix.
		const homeSessionId = createHomeAgentSessionId("workspace-1", "claude");
		const resolved = resolveAgentAppendSystemPrompt({
			taskId: homeSessionId,
			projectPath: "/repo",
			worktreesEnabled: true,
		});

		expect(resolved).not.toBeNull();
		expect(resolved).toContain("# Kanban Sidebar");
		expect(resolved?.toLowerCase()).toContain("worktree");
	});
});
