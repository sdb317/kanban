import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
	DEFAULT_WORKTREES_ENABLED,
	parseWorktreeSettingValue,
	resolveEffectiveWorktreesEnabled,
	resolveInPlaceDefaultBaseRef,
} from "../../../src/config/worktree-setting";

/**
 * Arbitrary spanning the full space of raw stored values a `worktreesEnabled`
 * key can hold: absent/undefined, real booleans, the strings "true"/"false",
 * numbers, null, objects, and arrays.
 */
const rawWorktreeSettingArbitrary: fc.Arbitrary<unknown> = fc.oneof(
	fc.constant(undefined),
	fc.boolean(),
	fc.constantFrom("true", "false"),
	fc.constantFrom(0, 1, 42),
	fc.constant(null),
	fc.object(),
	fc.array(fc.anything()),
);

/**
 * Independent reference model for effective resolution (Req 1.4-1.6).
 * Re-derived directly from the raw values rather than delegating to the
 * functions under test.
 */
function referenceEffective(rawGlobal: unknown, rawProject: unknown): boolean {
	if (typeof rawProject === "boolean") {
		return rawProject;
	}
	if (typeof rawGlobal === "boolean") {
		return rawGlobal;
	}
	return false;
}

describe("worktree-setting pure resolution", () => {
	// Property 1: Effective resolution matches the reference model.
	// Validates: Requirements 1.1, 1.4, 1.5, 1.6, 1.7, 1.8
	it("resolves the effective setting to match an independent reference model and is always boolean", () => {
		fc.assert(
			fc.property(rawWorktreeSettingArbitrary, rawWorktreeSettingArbitrary, (rawGlobal, rawProject) => {
				const globalWorktreesEnabled = parseWorktreeSettingValue(rawGlobal);
				const projectWorktreesEnabled = parseWorktreeSettingValue(rawProject);

				const result = resolveEffectiveWorktreesEnabled({
					globalWorktreesEnabled,
					projectWorktreesEnabled,
				});

				// Always a boolean (Req 1.8).
				expect(typeof result).toBe("boolean");
				// Matches the independent reference model (Req 1.4-1.6).
				expect(result).toBe(referenceEffective(rawGlobal, rawProject));
			}),
			{ numRuns: 1000 },
		);
	});

	// Parsing: only real JSON booleans are valid; everything else is unset (null).
	// Validates: Requirements 1.1, 1.7
	it("parses only real JSON booleans to a boolean and everything else to null", () => {
		fc.assert(
			fc.property(rawWorktreeSettingArbitrary, (raw) => {
				const parsed = parseWorktreeSettingValue(raw);
				if (typeof raw === "boolean") {
					expect(parsed).toBe(raw);
				} else {
					expect(parsed).toBeNull();
				}
			}),
			{ numRuns: 1000 },
		);
	});

	it("falls back to the default when neither source is a valid boolean", () => {
		const result = resolveEffectiveWorktreesEnabled({
			globalWorktreesEnabled: null,
			projectWorktreesEnabled: null,
		});
		expect(result).toBe(DEFAULT_WORKTREES_ENABLED);
	});
});

describe("resolveInPlaceDefaultBaseRef", () => {
	it("returns the current branch when present and an empty string otherwise", () => {
		fc.assert(
			fc.property(fc.option(fc.string(), { nil: null }), (currentBranch) => {
				expect(resolveInPlaceDefaultBaseRef({ currentBranch })).toBe(currentBranch ?? "");
			}),
			{ numRuns: 200 },
		);
		expect(resolveInPlaceDefaultBaseRef(null)).toBe("");
	});
});
