"""Fixed public markers only; no Agent imports, raw text, values, or inference."""

from __future__ import annotations

import re


LIMIT = 512 * 1024
CSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
OSC = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")

# fast-agent-mcp 0.10.1 core/fastagent.py:213-219,1145-1213.
# Neither the exception's message nor details are returned.
TEMPLATES = {
    "yaml_parsing": (
        "YAML Parsing Error:",
        "There was an error parsing the config or secrets YAML configuration file.",
    ),
    "server_configuration": (
        "Server Configuration Error:",
        "Please check your 'fast-agent.yaml' configuration file and add the missing server definitions.",
    ),
    "provider_configuration": (
        "Provider Configuration Error:",
        "Please check your 'fast-agent.secrets.yaml' configuration file and ensure all required API keys are set.",
    ),
    "agent_configuration": (
        "Workflow or Agent Configuration Error:",
        "Please check your agent definition and ensure names and references are correct.",
    ),
    "mcp_server_startup": (
        "MCP Server Startup Error:",
        "There was an error starting up the MCP Server.",
    ),
    "environment_startup": (
        "Environment Startup Error:",
        "Check the selected execution environment and any required local CLIs.",
    ),
    "model_configuration": (
        "Model Configuration Error:",
        "Common models: gpt-5.5, kimi, sonnet, haiku. Set reasoning effort on supported models with gpt-5.4-mini?reasoning=high",
    ),
    "circular_dependency": (
        "Circular Dependency Detected:",
        "Check your agent configuration for circular dependencies.",
    ),
    "environment_selection": (
        "Environment Selection Error:",
        "Choose one of the configured environments or update your 'fast-agent.yaml' configuration file.",
    ),
    "user_requested_exit": ("User requested exit:", None),
    "cancelled": ("Cancelled:", "The operation was cancelled."),
    "generic_error": ("Error:", "An unexpected error occurred."),
}
EXCEPTION_CLASSES = frozenset({
    "ServerConfigError", "ProviderKeyError", "AgentConfigError",
    "ServerInitializationError", "EnvironmentStartupError", "ModelConfigError",
    "CircularDependencyError", "UnknownEnvironmentError", "PromptExitError",
    "ConfigFileError", "ConfigDiscoveryError", "AmbiguousConfigFilesError",
    "AmbiguousSecretsFilesError", "ValidationError", "CancelledError",
    "ClickException", "UsageError", "BadParameter", "NoSuchOption",
    "ModuleNotFoundError", "ImportError", "TypeError", "ValueError",
    "AttributeError", "RuntimeError", "OSError", "PermissionError",
    "FileNotFoundError", "TimeoutError", "KeyError", "ParserError",
})


def classify_stderr(data: bytes) -> dict:
    """Observe fixed headings/pairs/format, never identify an unobserved cause."""
    text = OSC.sub("", CSI.sub("", data[:LIMIT].decode("utf-8", "replace")))
    lines = [line.strip() for line in text.splitlines()]
    normalized = " ".join(text.split())
    headings = sorted(key for key, (heading, _) in TEMPLATES.items() if heading in lines)
    # Pair matching tolerates Rich's wrapping of the static suggestion only.
    # It does not reconstruct or emit the intervening message/details.
    pairs = sorted(
        key for key in headings
        if TEMPLATES[key][1] is not None
        and " ".join(TEMPLATES[key][1].split()) in normalized
    )
    classes = sorted(
        name for name in EXCEPTION_CLASSES
        if re.search(r"(?m)^\s*(?:[│|]\s*)?" + re.escape(name) + r"(?=:|\s*$)", text)
    )
    formats = []
    if any(re.fullmatch(r"[╭┌][─ ]*Error[─ ]*[╮┐]", line) for line in lines):
        if any(re.fullmatch(r"[╰└][─ ]*[╯┘]", line) for line in lines):
            formats.append("rich_error_panel")
    if any(re.match(r"^Error: .+", line) for line in lines):
        formats.append("plain_error_prefix")
    if any(re.match(r"^Server stopped with error: .+", line) for line in lines):
        formats.append("fast_agent_server_stop_prefix")
    if "Traceback (most recent call last):" in lines:
        formats.append("python_traceback_header")
    if headings:
        formats.append("fixed_friendly_heading")
    return {
        "matchedFixedHeadingIds": headings,
        "matchedFixedHeadingAndSuggestionIds": pairs,
        "observedPublicExceptionClasses": classes,
        "formatMarkers": sorted(formats),
        "diagnosticBodyDiscarded": True,
        "inputBytes": len(data),
        "classificationInputTruncated": len(data) > LIMIT,
        "categoryUnclassified": not bool(headings or classes),
        "osErrorNumbers": sorted({int(code) for code in re.findall(r"\[Errno (2|13|30)\]", text)}),
        "knownRootHomeMentioned": "'/.fast-agent'" in text,
    }
