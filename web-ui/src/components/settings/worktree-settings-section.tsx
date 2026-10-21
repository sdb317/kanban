// "Use git worktrees" settings section: a global toggle plus an optional
// per-project override. Draft state is owned by the settings dialog (task 15.2);
// this component is a controlled presentation of that draft.
import * as RadixRadioGroup from "@radix-ui/react-radio-group";
import * as RadixSwitch from "@radix-ui/react-switch";
import type { ProjectWorktreeOverrideChoice } from "@/components/settings/build-worktree-save-request";
import { cn } from "@/components/ui/cn";

const PROJECT_OVERRIDE_OPTIONS: ReadonlyArray<{
	value: ProjectWorktreeOverrideChoice;
	label: string;
}> = [
	{ value: "global", label: "Use global default" },
	{ value: "off", label: "Off (in-place)" },
	{ value: "on", label: "On (worktrees)" },
];

export function WorktreeSettingsSection({
	globalWorktreesEnabled,
	onGlobalWorktreesEnabledChange,
	projectOverride,
	onProjectOverrideChange,
	disabled = false,
}: {
	/** Global "Use git worktrees" toggle state. */
	globalWorktreesEnabled: boolean;
	onGlobalWorktreesEnabledChange: (enabled: boolean) => void;
	/** Per-project override selection, or `null` when no project is selected. */
	projectOverride: ProjectWorktreeOverrideChoice | null;
	onProjectOverrideChange: (choice: ProjectWorktreeOverrideChoice) => void;
	disabled?: boolean;
}): React.ReactElement {
	return (
		<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
			<div className="flex items-center gap-2">
				<RadixSwitch.Root
					checked={globalWorktreesEnabled}
					disabled={disabled}
					onCheckedChange={onGlobalWorktreesEnabledChange}
					className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
				>
					<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
				</RadixSwitch.Root>
				<span className="text-[13px] text-text-primary">Use git worktrees</span>
			</div>
			<p className="text-text-secondary text-[13px] mt-2 mb-0">
				Give every task its own git worktree. When off, agents run in-place in the project folder with no worktrees,
				branches, checkpoints, or diffs.
			</p>

			{projectOverride !== null ? (
				<div className="mt-3 pt-3 border-t border-border">
					<h6 className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0 mb-2">
						This project
					</h6>
					<RadixRadioGroup.Root
						value={projectOverride}
						disabled={disabled}
						onValueChange={(value) => onProjectOverrideChange(value as ProjectWorktreeOverrideChoice)}
						className="flex flex-col gap-1.5"
					>
						{PROJECT_OVERRIDE_OPTIONS.map((option) => {
							const itemId = `worktree-override-${option.value}`;
							return (
								<label
									key={option.value}
									htmlFor={itemId}
									className={cn(
										"flex items-center gap-2 text-[13px] text-text-primary",
										disabled ? "cursor-default opacity-40" : "cursor-pointer",
									)}
								>
									<RadixRadioGroup.Item
										id={itemId}
										value={option.value}
										className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border bg-surface-2 data-[state=checked]:border-accent disabled:cursor-default"
									>
										<RadixRadioGroup.Indicator className="block h-2 w-2 rounded-full bg-accent" />
									</RadixRadioGroup.Item>
									<span>{option.label}</span>
								</label>
							);
						})}
					</RadixRadioGroup.Root>
				</div>
			) : null}
		</div>
	);
}
