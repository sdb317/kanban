// Feature: in-place-workspace-mode, Property 7: Settings draft maps to the minimal save request
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
	buildWorktreeSaveRequest,
	type ProjectWorktreeOverrideChoice,
	resolveProjectOverrideChoice,
	resolveProjectOverrideValue,
	type WorktreeSettingsDraft,
} from "@/components/settings/build-worktree-save-request";

// Loaded config stores worktree flags as tri-state values (null when unset).
const worktreeValueArb: fc.Arbitrary<boolean | null> = fc.constantFrom(true, false, null);
const overrideChoiceArb: fc.Arbitrary<ProjectWorktreeOverrideChoice | null> =
	fc.constantFrom<ProjectWorktreeOverrideChoice | null>("global", "off", "on", null);

const draftArb: fc.Arbitrary<WorktreeSettingsDraft> = fc.record({
	globalWorktreesEnabled: fc.boolean(),
	projectOverride: overrideChoiceArb,
});

const loadedArb = fc.record({
	globalWorktreesEnabled: worktreeValueArb,
	projectWorktreesEnabled: worktreeValueArb,
});

// Map the three-way choice to the stored value the same way the helper does,
// so the test asserts against an independent mapping rather than echoing it.
const CHOICE_TO_VALUE: Record<ProjectWorktreeOverrideChoice, boolean | null> = {
	global: null,
	off: false,
	on: true,
};

describe("buildWorktreeSaveRequest", () => {
	it("includes a field only when its mapped value differs from the loaded value (Property 7)", () => {
		fc.assert(
			fc.property(loadedArb, draftArb, (loaded, draft) => {
				const request = buildWorktreeSaveRequest(loaded, draft);

				// Global: an unset (null) loaded global reads as false in the UI toggle.
				const loadedGlobal = loaded.globalWorktreesEnabled === true;
				if (draft.globalWorktreesEnabled === loadedGlobal) {
					expect(request).not.toHaveProperty("worktreesEnabled");
				} else {
					expect(request.worktreesEnabled).toBe(draft.globalWorktreesEnabled);
				}

				// Project override: omitted when no project override is selected,
				// or when the mapped override equals the loaded project value.
				if (draft.projectOverride === null) {
					expect(request).not.toHaveProperty("projectWorktreesEnabled");
				} else {
					const mapped = CHOICE_TO_VALUE[draft.projectOverride];
					if (mapped === loaded.projectWorktreesEnabled) {
						expect(request).not.toHaveProperty("projectWorktreesEnabled");
					} else {
						expect(request.projectWorktreesEnabled).toBe(mapped);
					}
				}

				// The helper must never emit fields outside the two it owns.
				for (const key of Object.keys(request)) {
					expect(["worktreesEnabled", "projectWorktreesEnabled"]).toContain(key);
				}
			}),
			{ numRuns: 200 },
		);
	});

	it("round-trips resolveProjectOverrideChoice -> resolveProjectOverrideValue as identity (Property 7)", () => {
		fc.assert(
			fc.property(worktreeValueArb, (value) => {
				const choice = resolveProjectOverrideChoice(value);
				expect(resolveProjectOverrideValue(choice)).toBe(value);
			}),
			{ numRuns: 200 },
		);
	});

	it("maps each override choice to the documented stored value (Property 7)", () => {
		fc.assert(
			fc.property(fc.constantFrom<ProjectWorktreeOverrideChoice>("global", "off", "on"), (choice) => {
				expect(resolveProjectOverrideValue(choice)).toBe(CHOICE_TO_VALUE[choice]);
			}),
			{ numRuns: 100 },
		);
	});
});
