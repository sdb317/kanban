export function KanbanIcon({ size = 24, className }: { size?: number; className?: string }): React.ReactElement {
	return (
		<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" overflow="visible" className={className}>
			<g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="butt" stroke-linejoin="miter">
				<path d="M4.2 3L5.8 3L7 4.2L7 15.8L5.8 17L4.2 17L3 15.8L3 4.2L4.2 3Z"/>
				<path d="M11.2 3L12.8 3L14 4.2L14 19.8L12.8 21L11.2 21L10 19.8L10 4.2L11.2 3Z"/>
				<path d="M18.2 3L19.8 3L21 4.2L21 10.8L19.8 12L18.2 12L17 10.8L17 4.2L18.2 3Z"/>
			</g>
		</svg>

	);
}
