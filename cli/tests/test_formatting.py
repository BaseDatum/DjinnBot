"""Tests for formatting utilities."""

from djinnbot.formatting import format_ts, format_size, colored_status, STATUS_COLORS


def test_format_ts_valid():
    result = format_ts(1700000000000)
    assert "2023" in result
    assert ":" in result


def test_format_ts_none():
    assert format_ts(None) == "-"


def test_format_ts_zero():
    assert format_ts(0) == "-"


def test_format_ts_string():
    assert format_ts("not a number") == "-"


def test_format_size_bytes():
    assert format_size(500) == "500B"


def test_format_size_kilobytes():
    result = format_size(2048)
    assert "KB" in result
    assert "2.0" in result


def test_format_size_megabytes():
    result = format_size(2 * 1024 * 1024)
    assert "MB" in result
    assert "2.0" in result


def test_colored_status_known():
    result = colored_status("running")
    assert "yellow" in result
    assert "running" in result


def test_colored_status_unknown():
    result = colored_status("weird")
    assert "white" in result
    assert "weird" in result


def test_all_status_colors_defined():
    """All common statuses should have a color mapping."""
    expected = [
        "pending",
        "running",
        "completed",
        "failed",
        "cancelled",
        "paused",
        "idle",
    ]
    for s in expected:
        assert s in STATUS_COLORS
