import { expect, type Locator, type Page, test } from "@playwright/test";

// End-to-end coverage for the reported bug: when creating a task with the Cline
// agent and the Ollama provider, picking any model other than the first/default
// one (e.g. gemma4:e4b) must actually stick. Previously the selection snapped
// back to the provider's default model.
//
// A live Cline + Ollama runtime is required to exercise the real provider list.
// When that environment is not present (common in CI), the test skips instead of
// failing so it stays meaningful locally and safe everywhere.

async function openInlineCreateCard(page: Page): Promise<void> {
	const backlogColumn = page.locator('[data-column-id="backlog"]').first();
	await backlogColumn.getByRole("button", { name: "Create task" }).click();
	await expect(page.getByPlaceholder("Describe the task")).toBeVisible();
}

async function expandAgentSettings(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Override Agent Settings" }).click();
}

async function selectAgent(page: Page, label: string): Promise<boolean> {
	const agentSelect = page.getByLabel("Agent", { exact: false }).first();
	const agentCombo = page.locator("select").first();
	const select = (await agentSelect.count()) > 0 ? agentSelect : agentCombo;
	const option = select.locator("option", { hasText: label });
	if ((await option.count()) === 0) {
		return false;
	}
	await select.selectOption({ label });
	return true;
}

async function selectProvider(page: Page, name: string): Promise<boolean> {
	// The provider picker is a SearchSelectDropdown with a "Search providers..." input.
	const providerTrigger = page.getByRole("button").filter({ hasText: /provider|ollama|cline/i });
	if ((await providerTrigger.count()) === 0) {
		return false;
	}
	await providerTrigger.first().click();
	const search = page.getByPlaceholder("Search providers...");
	if ((await search.count()) === 0) {
		return false;
	}
	await search.fill(name);
	const option = page.getByRole("button").filter({ hasText: new RegExp(`^${name}$`, "i") });
	if ((await option.count()) === 0) {
		await page.keyboard.press("Escape");
		return false;
	}
	await option.first().click();
	return true;
}

async function openModelPicker(page: Page): Promise<Locator> {
	const modelTrigger = page.locator("#cline-chat-model-picker");
	await modelTrigger.click();
	const search = page.getByPlaceholder("Search models...");
	await expect(search).toBeVisible();
	return search;
}

test.describe("Cline + Ollama model selection", () => {
	test("selecting a non-default Ollama model keeps that model selected", async ({ page }) => {
		await page.goto("/");
		await openInlineCreateCard(page);
		await expandAgentSettings(page);

		const hasCline = await selectAgent(page, "Cline");
		test.skip(!hasCline, "Cline agent is not available in this runtime");

		// Ollama may be the default provider already; selecting it explicitly is
		// harmless and mirrors the reported scenario.
		await selectProvider(page, "Ollama");

		const modelSearch = await openModelPicker(page);

		// Collect the concrete model options (buttons inside the model popover,
		// excluding the "Default" placeholder row).
		const optionButtons = page
			.locator('[data-radix-popper-content-wrapper] button')
			.filter({ hasNot: page.locator("text=Default") });
		const optionCount = await optionButtons.count();
		test.skip(optionCount < 2, "Need at least two Ollama models pulled to test non-default selection");

		// Pick the last option to guarantee it is not the first/default model.
		const targetButton = optionButtons.nth(optionCount - 1);
		const targetLabel = (await targetButton.innerText()).trim();
		await modelSearch.fill(targetLabel);
		const filtered = page
			.locator('[data-radix-popper-content-wrapper] button')
			.filter({ hasText: targetLabel });
		await filtered.first().click();

		// The model trigger button must now show the model we selected, not the
		// provider default. Reopen is not needed; the trigger text reflects state.
		const modelTrigger = page.locator("#cline-chat-model-picker");
		await expect(modelTrigger).toContainText(targetLabel);
	});
});
