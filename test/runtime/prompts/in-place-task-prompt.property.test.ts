import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { renderInPlaceTaskAgentPrompt } from "../../../src/prompts/task-agent-prompt";

/**
 * The In-Place task prompt (task 7.1) is structured as a sequence of
 * `# `-prefixed markdown sections. The prohibition list — the only place
 * allowed to name the restricted git operations (Req 11.2) — lives in the
 * "Do not run these git commands" section.
 *
 * Property 16 (Req 11.4) is modeled the way the design specifies: strip the
 * prohibition section out of the rendered prompt and assert the remaining
 * text does not otherwise mention worktrees, detached HEAD, commits, or PRs.
 */
const PROHIBITION_HEADING = "# Do not run these git commands";

/**
 * Remove the prohibition section (its heading through to just before the next
 * top-level `# ` heading or end of string). Everything outside the prohibition
 * list must stay free of the restricted git vocabulary (Req 11.4).
 */
function stripProhibitionSection(prompt: string): string {
	const sections = prompt.split(/^(?=# )/m);
	return sections.filter((section) => !section.startsWith(PROHIBITION_HEADING)).join("");
}

/**
 * The seven git commands the prompt must name in the prohibition list,
 * expressed as `git <cmd>` exactly as Req 11.2 enumerates them.
 */
const PROHIBITED_GIT_COMMANDS = [
	"git commit",
	"git push",
	"git branch",
	"git checkout",
	"git stash",
	"git reset",
	"git worktree",
] as const;

/**
 * Arbitrary absolute project paths across POSIX and Windows shapes, including
 * spaces and unicode segments, to exercise Req 11.1's "include the absolute
 * path" guarantee against a wide input space.
 */
const absoluteProjectPathArbitrary: fc.Arbitrary<string> = fc.oneof(
	fc
		.array(
			fc.string({ minLength: 1 }).filter((s) => !s.includes("/")),
			{ minLength: 1, maxLength: 5 },
		)
		.map((segments) => `/${segments.join("/")}`),
	fc
		.array(
			fc.string({ minLength: 1 }).filter((s) => !s.includes("\\")),
			{ minLength: 1, maxLength: 5 },
		)
		.map((segments) => `C:\\${segments.join("\\")}`),
	fc.constantFrom("/Users/dev/my project", "/home/user/repo", "C:\\Users\\Bells\\Dev\\kanban", "/srv/work/проект"),
);

describe("renderInPlaceTaskAgentPrompt (Property 16)", () => {
	// Property 16: In-Place task prompt content.
	// Validates: Requirements 11.1, 11.2, 11.3, 11.4
	it("embeds the project path, lists the prohibited git commands, warns about concurrency, and keeps the rest clean", () => {
		fc.assert(
			fc.property(absoluteProjectPathArbitrary, (projectPath) => {
				const prompt = renderInPlaceTaskAgentPrompt(projectPath);

				// Req 11.1: the returned string contains the exact project path and
				// states that work happens in the shared project folder.
				expect(prompt).toContain(projectPath);
				expect(prompt.toLowerCase()).toContain("shared project folder");

				// Req 11.2: the prohibition list names each restricted git command.
				for (const command of PROHIBITED_GIT_COMMANDS) {
					expect(prompt).toContain(command);
				}

				// Req 11.3: the concurrency warning is present.
				const lower = prompt.toLowerCase();
				expect(lower).toContain("other agents");
				expect(lower).toContain("same");
				expect(lower.includes("concurrent") || lower.includes("same time") || lower.includes("same project")).toBe(
					true,
				);

				// Req 11.4: outside the prohibition list, the prompt does not otherwise
				// mention worktree, detached HEAD, commit, or pull request.
				const withoutProhibition = stripProhibitionSection(prompt).toLowerCase();
				expect(withoutProhibition).not.toContain("worktree");
				expect(withoutProhibition).not.toContain("detached head");
				expect(withoutProhibition).not.toContain("commit");
				expect(withoutProhibition).not.toContain("pull request");
			}),
			{ numRuns: 500 },
		);
	});

	it("isolates exactly the prohibition section when stripping", () => {
		const prompt = renderInPlaceTaskAgentPrompt("/tmp/example");
		const stripped = stripProhibitionSection(prompt);

		// The prohibition heading and its git vocabulary are gone after stripping,
		// confirming the strip targets the right section (guards Req 11.4 modeling).
		expect(stripped).not.toContain(PROHIBITION_HEADING);
		for (const command of PROHIBITED_GIT_COMMANDS) {
			expect(stripped).not.toContain(command);
		}
		// But the intro and shared-folder sections survive the strip.
		expect(stripped).toContain("/tmp/example");
		expect(stripped.toLowerCase()).toContain("shared project folder");
	});
});
