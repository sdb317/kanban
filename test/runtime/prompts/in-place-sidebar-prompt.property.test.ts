import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { type RuntimeAgentId, runtimeAgentIdSchema } from "../../../src/core/api-contract";
import { renderAppendSystemPrompt } from "../../../src/prompts/append-system-prompt";

/**
 * Property 17: In-Place sidebar prompt has no worktree guidance.
 * Validates: Requirements 11.5
 *
 * When `worktreesEnabled` is `false`, `renderAppendSystemPrompt` must swap the
 * Worktree Mode wording for the shared-folder variants in
 * `sidebar-prompt-in-place-sections.ts`. The design (Req 11.5) requires the
 * In-Place sidebar prompt to:
 *   - swap the worktree intro and the "inside `.cline/worktrees/`" bullet for
 *     shared-folder wording,
 *   - drop the auto-review paragraph,
 *   - drop the `--base-ref` / `--auto-review-*` flags from the `task create` /
 *     `task update` references,
 *   - reword `task done` / `task delete` / `task start` so they never mention
 *     worktree cleanup,
 * and otherwise contain no mention of worktrees.
 *
 * The forbidden-string list below is derived by diffing the Worktree Mode
 * (default) branch against the In-Place branch of `renderAppendSystemPrompt`:
 * each term appears only in the Worktree Mode wording that the In-Place
 * sections replace or remove.
 */

/** Every real agent id plus the `null` (unknown) agent. */
const AGENT_IDS: readonly (RuntimeAgentId | null)[] = [...runtimeAgentIdSchema.options, null];

/**
 * A representative set of command prefixes. The sidebar prompt interpolates the
 * prefix into every CLI reference block, so these exercise the common shapes
 * (default, npx/pnpm/yarn/bun launchers, and a raw node entrypoint) without
 * depending on `process.argv` / `process.execPath`.
 */
const COMMAND_PREFIXES: readonly string[] = [
	"kanban",
	"npx -y kanban",
	"pnpm dlx kanban",
	"yarn dlx kanban",
	"bun x kanban",
	"node /opt/kanban/dist/cli.js",
];

/**
 * Worktree-specific vocabulary that must never appear in the In-Place sidebar
 * prompt. Checked case-insensitively so capitalized variants (e.g. "Worktree")
 * are also caught.
 */
const FORBIDDEN_CASE_INSENSITIVE: readonly string[] = ["worktree", "worktrees", ".cline/worktrees", "detached head"];

/**
 * Flag/term fragments that are case-sensitive by nature (CLI flags). These come
 * from the Worktree Mode `task create` / `task update` references and the
 * auto-review paragraph, all of which the In-Place sections drop.
 */
const FORBIDDEN_CASE_SENSITIVE: readonly string[] = [
	"--base-ref",
	"--auto-review",
	"--auto-review-enabled",
	"--auto-review-mode",
];

/**
 * Phrases unique to the auto-review paragraph / worktree-cleanup wording that
 * the In-Place branch removes. Checked case-insensitively.
 */
const FORBIDDEN_PHRASES_CASE_INSENSITIVE: readonly string[] = [
	"auto-commit",
	"auto-open-pr",
	"automatic review actions",
	"clean up task worktrees",
	"ensuring its worktree",
	"base ref",
];

describe("renderAppendSystemPrompt In-Place sidebar (Property 17)", () => {
	// Property 17: In-Place sidebar prompt has no worktree guidance.
	// Validates: Requirements 11.5
	it("omits all worktree guidance for every agent id and command prefix", () => {
		fc.assert(
			fc.property(fc.constantFrom(...AGENT_IDS), fc.constantFrom(...COMMAND_PREFIXES), (agentId, commandPrefix) => {
				const prompt = renderAppendSystemPrompt(commandPrefix, {
					agentId,
					worktreesEnabled: false,
				});
				const lower = prompt.toLowerCase();

				for (const term of FORBIDDEN_CASE_INSENSITIVE) {
					expect(lower).not.toContain(term);
				}
				for (const term of FORBIDDEN_PHRASES_CASE_INSENSITIVE) {
					expect(lower).not.toContain(term);
				}
				for (const flag of FORBIDDEN_CASE_SENSITIVE) {
					expect(prompt).not.toContain(flag);
				}

				// Sanity: the shared-folder wording that replaces the worktree
				// guidance is present, so the In-Place branch really was selected.
				expect(lower).toContain("shared project folder");
			}),
			{ numRuns: 500 },
		);
	});

	it("still swaps in worktree guidance when worktreesEnabled is true (guards the diff)", () => {
		// Confirms the forbidden terms are specific to the In-Place branch: the
		// Worktree Mode prompt legitimately contains them, so their absence above
		// is a real swap, not a prompt that happens to omit them everywhere.
		const worktreePrompt = renderAppendSystemPrompt("kanban", {
			agentId: "claude",
			worktreesEnabled: true,
		});
		const lower = worktreePrompt.toLowerCase();

		expect(lower).toContain("worktree");
		expect(lower).toContain(".cline/worktrees");
		expect(worktreePrompt).toContain("--base-ref");
		expect(worktreePrompt).toContain("--auto-review-enabled");
		expect(worktreePrompt).toContain("--auto-review-mode");
	});
});
