"""Tier-1 trace connectors normalizing production traces into grad DatasetRecord dicts."""

from .parsers import (
    SUPPORTED_CONNECTORS,
    detect_source,
    normalize_traces,
    normalize_traces_with_stats,
    parse_row,
)

__all__ = ["SUPPORTED_CONNECTORS", "detect_source", "normalize_traces", "normalize_traces_with_stats", "parse_row"]
