"""Textual TUI for interactive chat with djinnbot agents."""

from __future__ import annotations

import json
import time
from typing import Optional

import httpx
from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Vertical, VerticalScroll
from textual.widgets import (
    Header,
    Input,
    Static,
    Markdown,
    Collapsible,
    TextArea,
)

from djinnbot.client import DjinnBotClient

# Activity labels — rendered inside a Markdown widget, so use markdown italic.
ACTIVITY_LABELS = {
    "idle": "",
    "thinking": " *thinking...*",
    "writing": " *writing...*",
    "tool": " *using {tool}...*",
    "connecting": " *connecting...*",
    "stopping": " *stopping...*",
}


def _format_json(data) -> str:
    """Pretty-format data as JSON."""
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except (json.JSONDecodeError, TypeError):
            return data
    try:
        return json.dumps(data, indent=2, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(data)


def _syntax_static(text: str, lexer: str = "json") -> Static:
    """Create a Static with syntax-highlighted content via Rich Syntax."""
    from rich.syntax import Syntax

    try:
        syntax = Syntax(
            text, lexer, theme="monokai", line_numbers=False, word_wrap=True
        )
        return Static(syntax)
    except Exception:
        return Static(text)


def _copyable_area(text: str, lexer: str = "json") -> TextArea:
    """Create a read-only TextArea for selectable/copyable content."""
    ta = TextArea(text, read_only=True, language=lexer, show_line_numbers=False)
    ta.styles.height = "auto"
    ta.styles.max_height = 30
    return ta


class TurnHeader(Static):
    """The name line for a user or assistant turn, with optional activity."""

    def __init__(self, name: str, **kwargs):
        super().__init__(**kwargs)
        self._name = name
        self._activity = ""

    def render(self) -> str:
        # Rich markup for the header — bold name + dim activity
        if self._activity:
            return (
                f"[bold]{self._name}:[/bold] [dim italic]{self._activity}[/dim italic]"
            )
        return f"[bold]{self._name}:[/bold]"

    def set_activity(self, activity: str):
        self._activity = activity
        self.refresh()


class BottomBar(Static):
    """Keybinding hints styled to blend with the terminal."""

    def render(self) -> str:
        return (
            "[dim]Esc[/dim] stop  "
            "[dim]Ctrl+C[/dim] quit  "
            "[dim]Enter[/dim] expand  "
            "[dim]</>arrow[/dim] collapse/expand"
        )


class ChatApp(App):
    """Textual app for chatting with a djinnbot agent."""

    TITLE = "djinn chat"
    CSS = """
    #chat-scroll {
        height: 1fr;
        padding: 1 2;
    }

    #chat-log {
        height: auto;
    }

    #status-bar {
        dock: top;
        height: 1;
        background: $surface;
        color: $text-muted;
        padding: 0 2;
    }

    #message-input {
        dock: bottom;
        margin: 0 1 1 1;
    }

    #bottom-bar {
        dock: bottom;
        height: 1;
        padding: 0 1;
        background: $surface;
        color: $text-muted;
    }

    TurnHeader {
        margin: 1 0 0 0;
        padding: 0 1;
    }

    .turn-text {
        margin: 0 0 0 1;
        padding: 0 1;
    }

    Collapsible {
        margin: 0 0 0 2;
        padding: 0;
    }

    Collapsible > Contents {
        padding: 0 0 0 2;
    }

    CollapsibleTitle {
        color: $text-muted;
        padding: 0;
    }

    CollapsibleTitle:hover {
        color: $text;
    }

    CollapsibleTitle:focus {
        color: $text;
    }

    TextArea {
        height: auto;
        max-height: 30;
    }
    """

    BINDINGS = [
        Binding("ctrl+c", "quit", "Quit", show=False),
        Binding("escape", "stop_response", "Stop response", show=False),
    ]

    def __init__(
        self,
        base_url: str,
        agent_id: str,
        agent_name: str,
        model: str,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.base_url = base_url
        self.agent_id = agent_id
        self.agent_name = agent_name
        self.model = model
        self.client = DjinnBotClient(base_url=base_url)
        self.session_id: Optional[str] = None

        # Turn state — tracks the current assistant response as a sequence
        # of widgets (header, text blocks, collapsibles) in the chat log.
        self._responding = False
        self._thinking = False
        self._turn_header: Optional[TurnHeader] = None
        self._current_text: Optional[Markdown] = None  # current text block
        self._thinking_collapsible: Optional[Collapsible] = None
        self._thinking_text: str = ""

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static("", id="status-bar")
        with VerticalScroll(id="chat-scroll"):
            yield Vertical(id="chat-log")
        yield Input(
            placeholder="Type a message... (Enter to send)",
            id="message-input",
        )
        yield BottomBar(id="bottom-bar")

    def on_mount(self) -> None:
        self.sub_title = f"{self.agent_name} ({self.model})"
        self._set_status("Starting session...")
        self.start_session()

    def on_key(self, event) -> None:
        """Right arrow expands, left arrow collapses focused Collapsible."""
        focused = self.focused
        if focused is None:
            return

        collapsible = None
        if isinstance(focused, Collapsible):
            collapsible = focused
        else:
            try:
                for ancestor in focused.ancestors:
                    if isinstance(ancestor, Collapsible):
                        collapsible = ancestor
                        break
            except Exception:
                pass

        if collapsible is None:
            return

        if event.key == "right" and collapsible.collapsed:
            collapsible.collapsed = False
            event.prevent_default()
            event.stop()
        elif event.key == "left" and not collapsible.collapsed:
            collapsible.collapsed = True
            event.prevent_default()
            event.stop()

    @work(thread=True)
    def start_session(self) -> None:
        try:
            result = self.client.start_chat(self.agent_id, model=self.model)
            self.session_id = result.get("sessionId")
            if not self.session_id:
                self.call_from_thread(self._set_status, "Error: no session ID returned")
                return

            self.call_from_thread(
                self._set_status,
                f"Session {self.session_id[:20]}... waiting for container",
            )

            for i in range(90):
                status = self.client.get_chat_status(self.agent_id, self.session_id)
                session_status = status.get("status", "unknown")
                if session_status in ("running", "ready"):
                    self.call_from_thread(self._set_status, f"{self.model}")
                    self.call_from_thread(self._enable_input)
                    self.call_from_thread(self._start_event_listener)
                    return
                elif session_status in ("failed", "completed", "not_found"):
                    error = status.get("error") or session_status
                    self.call_from_thread(self._set_status, f"Session failed: {error}")
                    return

                self.call_from_thread(
                    self._set_status,
                    f"Waiting for container... ({i + 1}s) [{session_status}]",
                )
                time.sleep(1)

            self.call_from_thread(
                self._set_status, "Timeout waiting for session to start"
            )
        except Exception as e:
            self.call_from_thread(self._set_status, f"Error: {e}")

    def _set_status(self, text: str) -> None:
        bar = self.query_one("#status-bar", Static)
        bar.update(f"[dim]{text}[/dim]")

    def _set_activity(self, activity_key: str, **fmt_kwargs) -> None:
        label = ACTIVITY_LABELS.get(activity_key, "")
        if fmt_kwargs:
            label = label.format(**fmt_kwargs)
        # Strip markdown — TurnHeader uses Rich markup, not Markdown
        plain = label.replace("*", "").strip()
        if self._turn_header is not None:
            self.call_from_thread(self._turn_header.set_activity, plain)

    def _enable_input(self) -> None:
        inp = self.query_one("#message-input", Input)
        inp.focus()

    def _start_event_listener(self) -> None:
        self.listen_for_events()

    # ── SSE event listener ──────────────────────────────────────────

    @work(thread=True)
    def listen_for_events(self) -> None:
        if not self.session_id:
            return

        try:
            for event in self.client.stream_chat_events(self.session_id):
                event_type = event.get("type", "")
                data = event.get("data", {})

                if event_type == "output":
                    content = data.get("content", "") if isinstance(data, dict) else ""
                    if content:
                        if self._thinking:
                            self._thinking = False
                            self._set_activity("writing")
                            self.call_from_thread(self._finalize_thinking)
                        self.call_from_thread(self._append_text, content)

                elif event_type == "thinking":
                    thinking_text = ""
                    if isinstance(data, dict):
                        thinking_text = data.get("thinking", "")
                    if not self._thinking:
                        self._thinking = True
                        self._thinking_text = ""
                        self._set_activity("thinking")
                        self.call_from_thread(self._start_thinking_block)
                    if thinking_text:
                        self._thinking_text += thinking_text
                        self.call_from_thread(
                            self._update_thinking_block, self._thinking_text
                        )

                elif event_type == "turn_end":
                    if self._thinking:
                        self._thinking = False
                        self.call_from_thread(self._finalize_thinking)
                    self.call_from_thread(self._finish_turn)

                elif event_type in ("step_start", "step_end"):
                    pass

                elif event_type == "response_aborted":
                    if self._thinking:
                        self._thinking = False
                        self.call_from_thread(self._finalize_thinking)
                    self.call_from_thread(self._finish_turn, True)

                elif event_type == "tool_start":
                    tool_name = (
                        data.get("toolName", "tool")
                        if isinstance(data, dict)
                        else "tool"
                    )
                    tool_args = data.get("args", {}) if isinstance(data, dict) else {}
                    self._set_activity("tool", tool=tool_name)
                    # Break the current text block so tool appears in sequence
                    self.call_from_thread(self._break_text)
                    self.call_from_thread(self._add_tool_call, tool_name, tool_args)

                elif event_type == "tool_end":
                    tool_name = (
                        data.get("toolName", "tool")
                        if isinstance(data, dict)
                        else "tool"
                    )
                    tool_result = (
                        data.get("result", "") if isinstance(data, dict) else ""
                    )
                    self.call_from_thread(self._add_tool_result, tool_name, tool_result)
                    self._set_activity("writing")

                elif event_type == "container_ready":
                    self.call_from_thread(self._set_status, f"{self.model}")

                elif event_type in ("container_busy", "container_idle"):
                    pass

                elif event_type == "container_exiting":
                    self.call_from_thread(
                        self._set_status, "Container shutting down..."
                    )

                elif event_type == "session_complete":
                    self.call_from_thread(self._set_status, "Session ended by server")
                    break

                elif event_type == "connected":
                    pass

                else:
                    if event_type and event_type != "heartbeat":
                        self.call_from_thread(
                            self._add_system_message,
                            f"[{event_type}] {json.dumps(data)[:100] if data else ''}",
                        )

        except Exception as e:
            self.call_from_thread(self._set_status, f"Stream disconnected: {e}")

    # ── Turn management ─────────────────────────────────────────────
    # An assistant turn is a sequence of widgets appended to #chat-log:
    #   TurnHeader  ("Agent:" with activity)
    #   Markdown    (text block 1)
    #   Collapsible (tool call)
    #   Collapsible (tool result)
    #   Markdown    (text block 2)
    #   ...
    # This ensures tools appear inline in the order they were called,
    # between the text that came before and after them.

    def _start_turn(self) -> None:
        """Begin an assistant turn — add the name header."""
        log = self.query_one("#chat-log", Vertical)
        header = TurnHeader(self.agent_name)
        header.set_activity("thinking...")
        log.mount(header)
        self._turn_header = header
        self._current_text = None
        self._responding = True
        self._scroll_to_bottom()

    def _append_text(self, text: str) -> None:
        """Append text to the current text block, or create a new one."""
        log = self.query_one("#chat-log", Vertical)
        if self._current_text is None:
            md = Markdown("", classes="turn-text")
            log.mount(md)
            self._current_text = md
        # Accumulate — Markdown.update() replaces, so we track the full text
        if not hasattr(self._current_text, "_accumulated"):
            self._current_text._accumulated = ""
        self._current_text._accumulated += text
        self._current_text.update(self._current_text._accumulated)
        self._scroll_to_bottom()

    def _break_text(self) -> None:
        """End the current text block so the next widget appears after it."""
        self._current_text = None

    def _finish_turn(self, aborted: bool = False) -> None:
        """End the assistant turn."""
        if aborted and self._current_text is not None:
            self._append_text("\n\n*[response stopped]*")
        if self._turn_header is not None:
            self._turn_header.set_activity("")
        self._turn_header = None
        self._current_text = None
        self._thinking_collapsible = None
        self._thinking_text = ""
        self._responding = False
        self._set_status(f"{self.model}")
        inp = self.query_one("#message-input", Input)
        inp.focus()

    def _add_user_message(self, content: str) -> None:
        log = self.query_one("#chat-log", Vertical)
        header = TurnHeader("You")
        log.mount(header)
        md = Markdown(content, classes="turn-text")
        log.mount(md)
        self._scroll_to_bottom()

    def _add_system_message(self, text: str) -> None:
        log = self.query_one("#chat-log", Vertical)
        log.mount(Static(f"[dim]{text}[/dim]"))
        self._scroll_to_bottom()

    # ── Thinking collapsible ────────────────────────────────────────

    def _start_thinking_block(self) -> None:
        log = self.query_one("#chat-log", Vertical)
        self._break_text()
        c = Collapsible(
            Static("[dim]...[/dim]"),
            title="Thinking",
            collapsed=True,
        )
        self._thinking_collapsible = c
        log.mount(c)
        self._scroll_to_bottom()

    def _update_thinking_block(self, text: str) -> None:
        if self._thinking_collapsible is None:
            return
        try:
            statics = self._thinking_collapsible.query(Static)
            if statics:
                preview = text[:300] + "..." if len(text) > 300 else text
                statics.first().update(f"[dim]{preview}[/dim]")
        except Exception:
            pass

    def _finalize_thinking(self) -> None:
        if self._thinking_collapsible is None:
            return
        try:
            statics = self._thinking_collapsible.query(Static)
            if statics and self._thinking_text:
                statics.first().update(f"[dim]{self._thinking_text}[/dim]")
            char_count = len(self._thinking_text)
            self._thinking_collapsible.title = f"Thinking ({char_count} chars)"
        except Exception:
            pass
        self._thinking_collapsible = None
        self._thinking_text = ""

    # ── Tool collapsibles ───────────────────────────────────────────

    def _add_tool_call(self, tool_name: str, args: dict) -> None:
        """Add a collapsed tool call block with args as copyable JSON."""
        log = self.query_one("#chat-log", Vertical)
        args_text = _format_json(args) if args else "{}"
        c = Collapsible(
            _copyable_area(args_text, "json"),
            title=f"Call: {tool_name}",
            collapsed=True,
        )
        log.mount(c)
        self._scroll_to_bottom()

    def _add_tool_result(self, tool_name: str, result) -> None:
        """Add a separate collapsed result block with copyable content."""
        log = self.query_one("#chat-log", Vertical)
        result_text = _format_json(result) if result else "(no output)"

        # Determine language for syntax highlighting
        lexer = "json"
        stripped = result_text.strip()
        if not (stripped.startswith("{") or stripped.startswith("[")):
            lexer = None  # plain text

        c = Collapsible(
            _copyable_area(result_text, lexer),
            title=f"Result: {tool_name}",
            collapsed=True,
        )
        log.mount(c)
        self._scroll_to_bottom()

    # ── Scrolling ───────────────────────────────────────────────────

    def _scroll_to_bottom(self) -> None:
        scroll = self.query_one("#chat-scroll", VerticalScroll)
        scroll.scroll_end(animate=False)

    # ── Input handling ──────────────────────────────────────────────

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        message = event.value.strip()
        if not message:
            return

        event.input.value = ""

        if not self.session_id:
            self._set_status("No active session")
            return

        self._add_user_message(message)
        self._start_turn()
        self.send_message(message)

    @work(thread=True)
    def send_message(self, message: str) -> None:
        try:
            self.client.send_chat_message(self.agent_id, self.session_id, message)
        except Exception as e:
            self.call_from_thread(self._add_system_message, f"Failed to send: {e}")
            self.call_from_thread(self._finish_turn)

    def action_stop_response(self) -> None:
        if self._responding and self.session_id:
            if self._turn_header is not None:
                self._turn_header.set_activity("stopping...")
            self.stop_response()

    @work(thread=True)
    def stop_response(self) -> None:
        try:
            self.client.stop_chat_response(self.agent_id, self.session_id)
        except Exception:
            pass

    def action_quit(self) -> None:
        if self.session_id:
            try:
                self.client.end_chat(self.agent_id, self.session_id)
            except Exception:
                pass
        self.client.close()
        self.exit()


def run_chat(
    base_url: str,
    agent_id: str,
    agent_name: str,
    model: str,
) -> None:
    """Launch the chat TUI."""
    app = ChatApp(
        base_url=base_url,
        agent_id=agent_id,
        agent_name=agent_name,
        model=model,
    )
    app.run()
