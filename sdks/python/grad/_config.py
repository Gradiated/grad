"""Client configuration: explicit arguments > environment variables > config file > defaults.

* ``GRADIATED_API_KEY`` and ``GRADIATED_BASE_URL`` are read from the environment.
* ``grad login`` writes ``$XDG_CONFIG_HOME/gradiated/config.json`` (default
  ``~/.config/gradiated/config.json``) as ``{"profiles": {"default": {"base_url", "api_key"}}}``;
  it is used for whatever the arguments and the environment leave unset.
* The default base URL is Gradiated Cloud, ``https://api.gradiated.com``.
"""

from __future__ import annotations

import ipaddress
import json
import os
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from ._errors import GradConfigError

DEFAULT_BASE_URL = "https://api.gradiated.com"
ENV_API_KEY = "GRADIATED_API_KEY"
ENV_BASE_URL = "GRADIATED_BASE_URL"
DEFAULT_PROFILE = "default"


def default_config_path(env: Mapping[str, str] | None = None) -> Path:
    """Location of the ``grad login`` config file for this environment."""
    env = os.environ if env is None else env
    base = env.get("XDG_CONFIG_HOME") or str(Path(env.get("HOME") or Path.home()) / ".config")
    return Path(base) / "gradiated" / "config.json"


def normalize_base_url(raw: str) -> str:
    """Validate a base URL (``http(s)://host[:port][/prefix]``) and strip the trailing slash."""
    text = raw.strip()
    parsed = urllib.parse.urlsplit(text)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise GradConfigError(
            f"Invalid base_url {raw!r}: expected http(s)://host[:port], e.g. https://api.gradiated.com "
            "or http://localhost:8787."
        )
    if parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise GradConfigError(f"Invalid base_url {raw!r}: it must not contain credentials, a query or a fragment.")
    try:
        parsed.port  # noqa: B018 - validates the port number
    except ValueError as exc:
        raise GradConfigError(f"Invalid base_url {raw!r}: {exc}.") from None
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def is_loopback(base_url: str) -> bool:
    """True when ``base_url`` points at this machine (local stacks often run without auth)."""
    host = urllib.parse.urlsplit(base_url).hostname or ""
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@dataclass(frozen=True)
class ResolvedConfig:
    """The configuration a client ended up with, and where each value came from."""

    base_url: str
    api_key: str | None
    profile: str
    sources: dict[str, str] = field(default_factory=dict)

    def __repr__(self) -> str:
        key = "None" if self.api_key is None else f"'{_mask(self.api_key)}'"
        return f"ResolvedConfig(base_url={self.base_url!r}, api_key={key}, profile={self.profile!r})"


def _mask(secret: str) -> str:
    return "" if not secret else f"{secret[:6]}…" if len(secret) > 10 else "…"


def _load_profile(path: Path, profile: str, *, required: bool) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        if required:
            raise GradConfigError(f"Profile '{profile}' was requested but {path} does not exist; run `grad login`.") from None
        return {}
    except OSError as exc:
        raise GradConfigError(f"Cannot read grad config file {path}: {exc}") from None
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise GradConfigError(f"Malformed grad config file {path}: {exc}. Fix it or run `grad login` again.") from None
    profiles = data.get("profiles") if isinstance(data, dict) else None
    if not isinstance(profiles, dict):
        raise GradConfigError(f'Malformed grad config file {path}: expected {{"profiles": {{"{profile}": {{...}}}}}}.')
    entry = profiles.get(profile)
    if entry is None:
        if required:
            known = ", ".join(sorted(str(k) for k in profiles)) or "none"
            raise GradConfigError(f"Profile '{profile}' is not in {path} (profiles: {known}).")
        return {}
    if not isinstance(entry, dict):
        raise GradConfigError(f"Malformed profile '{profile}' in {path}: expected an object.")
    return entry


def resolve_config(
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    profile: str | None = None,
    config_path: str | os.PathLike[str] | None = None,
    env: Mapping[str, str] | None = None,
    require_key: bool = True,
) -> ResolvedConfig:
    """Resolve ``base_url`` and ``api_key`` with precedence explicit > env > config file > default.

    ``api_key=""`` explicitly disables authentication (for auth-less servers). When no key
    is found and the server is not on loopback, this raises :class:`GradConfigError`
    naming ``GRADIATED_API_KEY`` and ``grad login``.
    """
    env = os.environ if env is None else env
    sources: dict[str, str] = {}
    resolved_url: str | None = None
    resolved_key: str | None = None

    if base_url is not None:
        resolved_url, sources["base_url"] = base_url, "argument"
    elif env.get(ENV_BASE_URL):
        resolved_url, sources["base_url"] = env[ENV_BASE_URL], f"env:{ENV_BASE_URL}"

    if api_key is not None:
        resolved_key, sources["api_key"] = api_key, "argument"
    elif env.get(ENV_API_KEY):
        resolved_key, sources["api_key"] = env[ENV_API_KEY], f"env:{ENV_API_KEY}"

    name = profile or DEFAULT_PROFILE
    if resolved_url is None or resolved_key is None or profile is not None:
        path = Path(config_path) if config_path is not None else default_config_path(env)
        entry = _load_profile(path, name, required=profile is not None)
        file_url = entry.get("base_url")
        file_key = entry.get("api_key")
        if resolved_url is None and isinstance(file_url, str) and file_url:
            resolved_url, sources["base_url"] = file_url, f"config:{path}#{name}"
        if resolved_key is None and isinstance(file_key, str) and file_key:
            resolved_key, sources["api_key"] = file_key, f"config:{path}#{name}"

    if resolved_url is None:
        resolved_url, sources["base_url"] = DEFAULT_BASE_URL, "default"
    normalized = normalize_base_url(resolved_url)

    if resolved_key is not None:
        resolved_key = resolved_key.strip()
        if any(ch.isspace() for ch in resolved_key):
            raise GradConfigError("The API key contains whitespace; check GRADIATED_API_KEY.")
    if not resolved_key:
        if require_key and resolved_key is None and not is_loopback(normalized):
            raise GradConfigError(
                f"No API key found for {normalized}. Set {ENV_API_KEY}, pass Grad(api_key=...), "
                f"or run `grad login` (it writes {default_config_path(env)}). "
                'Pass api_key="" to talk to a server without authentication.'
            )
        resolved_key = None
    return ResolvedConfig(base_url=normalized, api_key=resolved_key, profile=name, sources=sources)
