"""Client configuration: arguments > selected profile > environment > default profile > Cloud.

* ``GRADIATED_API_KEY``, ``GRADIATED_BASE_URL`` and ``GRADIATED_PROFILE`` are read from the
  environment; a profile selected by ``GRADIATED_PROFILE`` wins over the other two.
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
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from ._errors import GradConfigError

DEFAULT_BASE_URL = "https://api.gradiated.com"
ENV_API_KEY = "GRADIATED_API_KEY"
ENV_BASE_URL = "GRADIATED_BASE_URL"
ENV_PROFILE = "GRADIATED_PROFILE"
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


def missing_key_message(base_url: str) -> str:
    """The error every SDK and the CLI give when no API key is configured for a remote server."""
    return (
        f"No API key for {base_url}: run `grad login`, set {ENV_API_KEY}, "
        f"or export {ENV_PROFILE}=local to use a `grad local up` stack."
    )


def strip_api_suffix(base_url: str) -> str:
    """Drop a trailing ``/v1`` (the SDK adds it), warning once so the config gets fixed."""
    if base_url.endswith("/v1"):
        warnings.warn(
            f"base_url {base_url!r} ends in /v1; the SDK adds /v1 itself, so it was dropped.",
            stacklevel=4,
        )
        return base_url[: -len("/v1")]
    return base_url


def resolve_config(
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    profile: str | None = None,
    config_path: str | os.PathLike[str] | None = None,
    env: Mapping[str, str] | None = None,
    require_key: bool = True,
) -> ResolvedConfig:
    """Resolve ``base_url`` and ``api_key``; every SDK and the CLI use this precedence.

    1. explicit arguments (``api_key=``, ``base_url=``);
    2. an explicitly selected profile (``profile=`` or ``GRADIATED_PROFILE``);
    3. ``GRADIATED_API_KEY`` / ``GRADIATED_BASE_URL``;
    4. the ``default`` profile of the ``grad login`` config file;
    5. ``https://api.gradiated.com``.

    A key saved in a profile is only sent to that profile's own base URL. A selected
    profile that does not exist is an error. ``api_key=""`` explicitly disables
    authentication (for auth-less servers). When no key is found and the server is not
    on loopback, this raises :class:`GradConfigError` before any request is sent.
    """
    env = os.environ if env is None else env
    sources: dict[str, str] = {}

    explicit = profile or env.get(ENV_PROFILE) or None
    name = explicit or DEFAULT_PROFILE
    path = Path(config_path) if config_path is not None else default_config_path(env)
    covered = (base_url is not None or bool(env.get(ENV_BASE_URL))) and (api_key is not None or bool(env.get(ENV_API_KEY)))
    entry = {} if covered and explicit is None else _load_profile(path, name, required=explicit is not None)
    file_url = entry.get("base_url") if isinstance(entry.get("base_url"), str) and entry.get("base_url") else None
    file_key = entry.get("api_key") if isinstance(entry.get("api_key"), str) and entry.get("api_key") else None
    file_src = f"config:{path}#{name}"

    resolved_url: str | None = None
    if base_url is not None:
        resolved_url, sources["base_url"] = base_url, "argument"
    elif explicit is not None and file_url:
        resolved_url, sources["base_url"] = file_url, file_src
    elif env.get(ENV_BASE_URL):
        resolved_url, sources["base_url"] = env[ENV_BASE_URL], f"env:{ENV_BASE_URL}"
    elif file_url:
        resolved_url, sources["base_url"] = file_url, file_src
    else:
        resolved_url, sources["base_url"] = DEFAULT_BASE_URL, "default"
    normalized = strip_api_suffix(normalize_base_url(resolved_url))

    # A saved key belongs to its profile's server: never send it anywhere else.
    owner = strip_api_suffix(normalize_base_url(file_url)) if file_url else DEFAULT_BASE_URL
    usable_file_key = file_key if file_key and owner == normalized else None

    resolved_key: str | None = None
    if api_key is not None:
        resolved_key, sources["api_key"] = api_key, "argument"
    elif explicit is not None and usable_file_key:
        resolved_key, sources["api_key"] = usable_file_key, file_src
    elif env.get(ENV_API_KEY):
        resolved_key, sources["api_key"] = env[ENV_API_KEY], f"env:{ENV_API_KEY}"
    elif usable_file_key:
        resolved_key, sources["api_key"] = usable_file_key, file_src

    if resolved_key is not None:
        resolved_key = resolved_key.strip()
        if any(ch.isspace() for ch in resolved_key):
            raise GradConfigError("The API key contains whitespace; check GRADIATED_API_KEY.")
    if not resolved_key:
        if require_key and resolved_key is None and not is_loopback(normalized):
            note = ""
            if file_key and not usable_file_key:
                note = f" (the key saved in profile '{name}' belongs to {owner}, so it was not sent)"
            raise GradConfigError(missing_key_message(normalized) + note)
        resolved_key = None
    return ResolvedConfig(base_url=normalized, api_key=resolved_key, profile=name, sources=sources)
