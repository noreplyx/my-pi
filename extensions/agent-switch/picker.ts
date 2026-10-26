/**
 * Agent picker — searchable selector cloned 1:1 from pi's built-in
 * `ModelSelectorComponent` (minus catalog refresh / scope tab /
 * save-as-default, which have no agent equivalent).
 *
 * Layout, keybindings, and filtering all mirror `/model`:
 * `DynamicBorder / hint / Input / list / key-hints / DynamicBorder`,
 * `fuzzyFilter` narrowing with selection reset to 0, ↑↓ wrap-around,
 * Enter picks `filtered[selectedIndex]` (both `Input.onSubmit` and
 * `handleInput` confirm), Esc cancels fail-closed.
 */

import {
	Container,
	Input,
	Spacer,
	Text,
	fuzzyFilter,
	getKeybindings,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	DynamicBorder,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../subagent/agents.ts";

/** One picker row. `agent: null` is the "(default session — clear override)" reset row. */
export interface AgentPickerItem {
	label: string;
	agent: AgentConfig | null;
}

/**
 * Search corpus for an item. Mirrors `getModelSelectorSearchText`
 * (`provider provider/id … name`): name first for exact-prefix ranking,
 * then source and description so `user`, `project`, or any description
 * word filters.
 */
export function getAgentSearchText(item: AgentPickerItem): string {
	if (!item.agent) return `default reset clear session ${item.label}`;
	const { name, source, description } = item.agent;
	return `${name} ${source} ${name}/${source} ${description}`;
}

function truncate(s: string, max: number): string {
	const oneLine = s.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export class AgentPickerComponent extends Container {
	private searchInput: Input;
	// Focusable implementation - propagate to searchInput for IME cursor positioning.
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private listContainer: Container;
	private all: AgentPickerItem[] = [];
	private filtered: AgentPickerItem[] = [];
	private selectedIndex = 0;
	private currentName: string | undefined;
	private onSelectCallback: (item: AgentPickerItem) => void;
	private onCancelCallback: () => void;
	private tui: TUI;
	private theme: Theme;
	private closed = false;

	constructor(
		tui: TUI,
		theme: Theme,
		items: AgentPickerItem[],
		currentName: string | undefined,
		onSelect: (item: AgentPickerItem) => void,
		onCancel: () => void,
		initialSearchInput?: string,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.currentName = currentName;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		const border = (s: string) => theme.fg("border", s);
		// Add top border
		this.addChild(new DynamicBorder(border));
		this.addChild(new Spacer(1));
		// Hint about filtering (mirrors the model picker's scope/hint line).
		this.addChild(new Text(theme.fg("muted", "Type to filter agents."), 0, 0));
		this.addChild(new Spacer(1));
		// Create search input
		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			// Enter on search input selects the highlighted filtered item
			const item = this.filtered[this.selectedIndex];
			if (item) {
				this.handleSelect(item);
			}
		};
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		// Hint. Static glyphs (not keyHint/rawKeyHint): those helpers read the
		// global theme singleton, which is uninitialized in extension/test
		// contexts — the factory-injected theme is the only safe styling here.
		this.addChild(
			new Text(theme.fg("dim", "  ↑↓ navigate · Enter select · Esc cancel"), 0, 0),
		);
		// Add bottom border
		this.addChild(new DynamicBorder(border));

		this.all = this.sortItems(items);
		this.filtered = this.all;
		const currentIndex = this.filtered.findIndex(
			(i) => i.agent?.name === this.currentName,
		);
		this.selectedIndex =
			currentIndex >= 0
				? currentIndex
				: Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));

		if (initialSearchInput) this.filterAgents(initialSearchInput);
		else this.updateList();
		this.tui.requestRender();
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
	}

	private sortItems(items: AgentPickerItem[]): AgentPickerItem[] {
		const sorted = [...items];
		// Sort: current agent first, then discovery order (already alphabetical).
		// The reset row (agent: null) always stays at the top.
		const rank = (i: AgentPickerItem): number => {
			if (i.agent === null) return -1;
			if (i.agent.name === this.currentName) return 0;
			return 1;
		};
		sorted.sort((a, b) => rank(a) - rank(b));
		return sorted;
	}

	filterAgents(query: string): void {
		if (query) {
			this.filtered = fuzzyFilter(this.all, query, getAgentSearchText);
		} else {
			this.filtered = this.all;
		}
		// When filtering by a query, move the selector to the top row so the best
		// match is highlighted. When the query is cleared, keep the current position
		// clamped to the (restored) list length.
		this.selectedIndex = query
			? 0
			: Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
		this.updateList();
	}

	private updateList(): void {
		const theme = this.theme;
		this.listContainer.clear();
		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(maxVisible / 2),
				this.filtered.length - maxVisible,
			),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filtered.length);
		// Show visible slice of filtered agents
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filtered[i];
			if (!item) continue;
			const isSelected = i === this.selectedIndex;
			const isCurrent =
				item.agent !== null && item.agent.name === this.currentName;
			const cursor = isSelected ? theme.fg("accent", "→ ") : "  ";
			const currentMarker = isCurrent ? theme.fg("accent", "✓ ") : "  ";
			const nameText = isSelected
				? theme.fg("accent", item.agent?.name ?? item.label)
				: (item.agent?.name ?? item.label);
			const sourceBadge = item.agent
				? theme.fg("muted", ` [${item.agent.source}]`)
				: "";
			const line = `${cursor}${currentMarker}${nameText}${sourceBadge}`;
			this.listContainer.addChild(new Text(line, 0, 0));
		}
		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filtered.length) {
			const scrollInfo = theme.fg(
				"muted",
				`  (${this.selectedIndex + 1}/${this.filtered.length})`,
			);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}
		// Show detail footer for the highlighted row, or "no results" if empty
		if (this.filtered.length === 0) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", "  No matching agents"), 0, 0),
			);
		} else {
			const selected = this.filtered[this.selectedIndex];
			if (selected?.agent) {
				this.listContainer.addChild(new Spacer(1));
				this.listContainer.addChild(
					new Text(
						theme.fg("muted", `  Description: ${truncate(selected.agent.description, 120)}`),
						0,
						0,
					),
				);
			}
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filtered.length === 0) return;
			this.selectedIndex =
				this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
			this.updateList();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filtered.length === 0) return;
			this.selectedIndex =
				this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const item = this.filtered[this.selectedIndex];
			if (item) {
				this.handleSelect(item);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			this.dispose();
			this.onCancelCallback();
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterAgents(this.searchInput.getValue());
		}
	}

	private handleSelect(item: AgentPickerItem): void {
		this.dispose();
		this.onSelectCallback(item);
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
