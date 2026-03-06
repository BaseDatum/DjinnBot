"""Interactive selection pickers using Textual.

Provides full-screen selection widgets with vim keybindings
(j/k to navigate, Enter to select) and arrow key support.
The model picker includes fuzzy search filtering.
"""

from __future__ import annotations

from typing import Optional

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.widgets import Header, Static, ListItem, ListView, Input


class PickerItem(ListItem):
    """A single selectable item in the picker."""

    def __init__(self, item_id: str, label: str, description: str = "", **kwargs):
        super().__init__(**kwargs)
        self.item_id = item_id
        self.label_text = label
        self.description = description

    def compose(self) -> ComposeResult:
        if self.description:
            yield Static(
                f"[bold]{self.label_text}[/bold]\n[dim]{self.description}[/dim]"
            )
        else:
            yield Static(f"[bold]{self.label_text}[/bold]")


class BottomHints(Static):
    """Minimal keybinding hints styled to blend with the terminal."""

    def render(self) -> str:
        return (
            "[dim]j/k[/dim] navigate  [dim]Enter[/dim] select  [dim]q/Esc[/dim] cancel"
        )


class PickerApp(App):
    """Generic full-screen picker with vim + arrow key navigation."""

    CSS = """
    ListView {
        height: 1fr;
        padding: 1 2;
    }
    ListView > ListItem {
        padding: 0 2;
        height: auto;
    }
    ListView > ListItem.--highlight {
        background: $accent 30%;
    }
    #title-bar {
        dock: top;
        height: 1;
        background: $surface;
        color: $text;
        padding: 0 2;
        text-style: bold;
    }
    #bottom-hints {
        dock: bottom;
        height: 1;
        padding: 0 1;
        background: $surface;
        color: $text-muted;
    }
    """

    BINDINGS = [
        Binding("j", "cursor_down", "Down", show=False),
        Binding("k", "cursor_up", "Up", show=False),
        Binding("enter", "select_item", "Select", show=False),
        Binding("q", "quit_picker", "Cancel", show=False),
        Binding("escape", "quit_picker", "Cancel", show=False),
    ]

    def __init__(
        self,
        title: str,
        items: list[tuple[str, str, str]],
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.picker_title = title
        self.items = items
        self.selected_id: Optional[str] = None

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static(f" {self.picker_title}", id="title-bar")
        yield ListView(
            *[
                PickerItem(item_id=i[0], label=i[1], description=i[2])
                for i in self.items
            ],
            id="picker-list",
        )
        yield BottomHints(id="bottom-hints")

    def action_cursor_down(self) -> None:
        lv = self.query_one("#picker-list", ListView)
        lv.action_cursor_down()

    def action_cursor_up(self) -> None:
        lv = self.query_one("#picker-list", ListView)
        lv.action_cursor_up()

    def action_select_item(self) -> None:
        lv = self.query_one("#picker-list", ListView)
        if lv.highlighted_child is not None:
            item = lv.highlighted_child
            if isinstance(item, PickerItem):
                self.selected_id = item.item_id
                self.exit()

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        if isinstance(event.item, PickerItem):
            self.selected_id = event.item.item_id
            self.exit()

    def action_quit_picker(self) -> None:
        self.selected_id = None
        self.exit()


class SearchBottomHints(Static):
    """Hints for the searchable picker."""

    def render(self) -> str:
        return "[dim]Up/Down[/dim] navigate  [dim]Enter[/dim] select  [dim]Esc[/dim] cancel  [dim]type to filter[/dim]"


class SearchablePickerApp(App):
    """Picker with a search input for fuzzy filtering.

    Typing filters the list in real time. Arrow keys navigate
    the filtered results. Enter selects, Esc cancels.
    """

    CSS = """
    #search-input {
        dock: top;
        margin: 0 1;
    }
    #title-bar {
        dock: top;
        height: 1;
        background: $surface;
        color: $text;
        padding: 0 2;
        text-style: bold;
    }
    ListView {
        height: 1fr;
        padding: 0 2;
    }
    ListView > ListItem {
        padding: 0 2;
        height: auto;
    }
    ListView > ListItem.--highlight {
        background: $accent 30%;
    }
    #bottom-hints {
        dock: bottom;
        height: 1;
        padding: 0 1;
        background: $surface;
        color: $text-muted;
    }
    #match-count {
        dock: bottom;
        height: 1;
        padding: 0 2;
        color: $text-muted;
    }
    """

    BINDINGS = [
        Binding("escape", "quit_picker", "Cancel", show=False),
    ]

    def __init__(
        self,
        title: str,
        items: list[tuple[str, str, str]],
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.picker_title = title
        self.all_items = items
        self.selected_id: Optional[str] = None

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static(f" {self.picker_title}", id="title-bar")
        yield Input(placeholder="Type to filter...", id="search-input")
        yield ListView(
            *[
                PickerItem(item_id=i[0], label=i[1], description=i[2])
                for i in self.all_items
            ],
            id="picker-list",
        )
        yield Static("", id="match-count")
        yield SearchBottomHints(id="bottom-hints")

    def on_mount(self) -> None:
        self.query_one("#search-input", Input).focus()
        self._update_count(len(self.all_items))

    def on_key(self, event) -> None:
        """Arrow keys navigate the list even when the search input is focused."""
        if event.key in ("up", "down"):
            lv = self.query_one("#picker-list", ListView)
            if event.key == "down":
                lv.action_cursor_down()
            else:
                lv.action_cursor_up()
            event.prevent_default()
            event.stop()

    def on_input_changed(self, event: Input.Changed) -> None:
        """Filter the list as the user types."""
        query = event.value.strip().lower()
        lv = self.query_one("#picker-list", ListView)
        lv.clear()

        if not query:
            filtered = self.all_items
        else:
            filtered = []
            for item_id, label, desc in self.all_items:
                haystack = f"{item_id} {label} {desc}".lower()
                if _fuzzy_match(query, haystack):
                    filtered.append((item_id, label, desc))

        for item_id, label, desc in filtered:
            lv.append(PickerItem(item_id=item_id, label=label, description=desc))

        self._update_count(len(filtered))

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        """Enter in the search box selects the highlighted item."""
        lv = self.query_one("#picker-list", ListView)
        if lv.highlighted_child is not None:
            item = lv.highlighted_child
            if isinstance(item, PickerItem):
                self.selected_id = item.item_id
                self.exit()

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        if isinstance(event.item, PickerItem):
            self.selected_id = event.item.item_id
            self.exit()

    def _update_count(self, count: int) -> None:
        total = len(self.all_items)
        label = self.query_one("#match-count", Static)
        if count == total:
            label.update(f"[dim]{total} models[/dim]")
        else:
            label.update(f"[dim]{count} of {total} models[/dim]")

    def action_quit_picker(self) -> None:
        self.selected_id = None
        self.exit()


def _fuzzy_match(query: str, haystack: str) -> bool:
    """Simple fuzzy match: all query chars must appear in order in haystack."""
    it = iter(haystack)
    return all(c in it for c in query)


def pick_agent(agents: list[dict]) -> Optional[str]:
    """Show an interactive agent picker. Returns the selected agent_id or None."""
    items = []
    for a in agents:
        emoji = a.get("emoji") or ""
        name = a.get("name", a.get("id", "?"))
        label = f"{emoji} {name}".strip()
        agent_id = a.get("id", "")
        role = a.get("role") or ""
        desc = a.get("description") or role
        items.append((agent_id, label, desc))

    if not items:
        return None

    app = PickerApp(title="Select an agent", items=items)
    app.run()
    return app.selected_id


def pick_model(models: list[dict]) -> Optional[str]:
    """Show an interactive model picker with fuzzy search.

    Models should be dicts with {id, name, provider, reasoning}.
    """
    items = []
    for m in models:
        model_id = m.get("id", "")
        name = m.get("name", model_id)
        provider = m.get("provider", "")
        reasoning = " [reasoning]" if m.get("reasoning") else ""
        label = name
        desc = f"{provider}{reasoning}" if provider else reasoning.strip()
        items.append((model_id, label, desc))

    if not items:
        return None

    app = SearchablePickerApp(title="Select a model", items=items)
    app.run()
    return app.selected_id
