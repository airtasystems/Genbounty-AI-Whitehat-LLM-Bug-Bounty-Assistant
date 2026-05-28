"""
Auth state: full capture and load (cookies, localStorage, sessionStorage, headers).

Primary store: ``sites/{site}/{component}/auth.json``
Fallback (legacy): ``sites/{site}/auth.json``
"""

import json
from pathlib import Path
from typing import Any

AUTH_FILE = "auth.json"
STORAGE_STATE_FILE = "storage_state.json"  # Legacy

PUBLIC_AUTH_TEMPLATE: dict[str, Any] = {
    "cookies": [],
    "origins": [],
    "headers": {},
    "query_params": {},
    "auth_mode": "none",
}


def _site_dir(site: str) -> Path:
    from browser_bot.sites import _domain_to_site_dir

    return _domain_to_site_dir(site)


def _component_dir(site: str, component: str) -> Path:
    return _site_dir(site) / component


def get_auth_path(site: str, component: str | None = None) -> Path:
    """Directory that holds auth for a site or component."""
    if component:
        return _component_dir(site, component)
    return _site_dir(site)


def _auth_file_candidates(site: str, component: str | None) -> list[Path]:
    candidates: list[Path] = []
    if component:
        comp_dir = _component_dir(site, component)
        candidates.extend([comp_dir / AUTH_FILE, comp_dir / STORAGE_STATE_FILE])
    site_dir = _site_dir(site)
    candidates.extend([site_dir / AUTH_FILE, site_dir / STORAGE_STATE_FILE])
    return candidates


def resolve_auth_read_path(site: str, component: str | None = None) -> Path | None:
    """Return existing auth file path (component first, then site fallback)."""
    for path in _auth_file_candidates(site, component):
        if path.is_file():
            return path
    return None


def resolve_auth_scope(site: str, component: str | None = None) -> str:
    """Return ``component``, ``site``, or ``none`` for the resolved auth file."""
    path = resolve_auth_read_path(site, component)
    if not path:
        return "none"
    if component and path.parent == _component_dir(site, component):
        return "component"
    return "site"


def get_auth_write_path(site: str, component: str | None = None) -> Path:
    """Path to write auth.json (component dir when component is set)."""
    if component:
        from browser_bot.sites import ensure_component_dir

        ensure_component_dir(site, component)
        return _component_dir(site, component) / AUTH_FILE
    from browser_bot.sites import ensure_site_dir

    ensure_site_dir(site)
    return _site_dir(site) / AUTH_FILE


def get_auth_config_path(site: str, component: str | None = None) -> Path:
    """Preferred auth path for reads; falls back to site-level legacy path."""
    resolved = resolve_auth_read_path(site, component)
    if resolved:
        return resolved
    if component:
        return _component_dir(site, component) / AUTH_FILE
    return _site_dir(site) / AUTH_FILE


def auth_config_exists(site: str, component: str | None = None) -> bool:
    """True if auth config exists for component (with site fallback) or site only."""
    return resolve_auth_read_path(site, component) is not None


def load_auth_config(site: str, component: str | None = None) -> dict[str, Any] | None:
    """Load auth config. Returns dict or None if not found."""
    path = resolve_auth_read_path(site, component)
    if not path:
        return None
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return _normalize_auth_config(data)


def _normalize_auth_config(data: dict) -> dict:
    """Normalize legacy storage_state or full auth.json to unified format."""
    for origin in data.get("origins", []):
        if "sessionStorage" not in origin:
            origin["sessionStorage"] = []
    if "headers" not in data:
        data["headers"] = {}
    if "query_params" not in data:
        data["query_params"] = {}
    return data


def save_auth_config(site: str, config: dict[str, Any], component: str | None = None) -> Path:
    """Save auth config to component or site auth.json."""
    path = get_auth_write_path(site, component)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    return path


def clear_auth_config(site: str, component: str | None = None) -> Path:
    """Reset auth so the user can choose login vs public access again."""
    path = get_auth_write_path(site, component)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{}", encoding="utf-8")
    return path


def is_auth_configured(site: str, component: str | None = None) -> bool:
    """True when auth is ready for browser/API runs."""
    config = load_auth_config(site, component)
    if not config:
        return False
    mode = config.get("auth_mode")
    if mode == "none":
        return True
    if mode == "api_key":
        return bool(config.get("headers") or config.get("query_params"))
    if config.get("cookies"):
        return True
    return any(
        o.get("localStorage") or o.get("sessionStorage")
        for o in config.get("origins", [])
    )


def auth_mode_for_domain(site: str, component: str | None = None) -> str | None:
    """Return ``none``, ``api_key``, ``session``, or None when auth is not configured."""
    if not is_auth_configured(site, component):
        return None
    config = load_auth_config(site, component) or {}
    mode = config.get("auth_mode")
    if mode in ("none", "api_key"):
        return mode
    return "session"


def save_public_auth(site: str, component: str | None = None) -> Path:
    """Save a no-login auth stub for public targets."""
    return save_auth_config(site, dict(PUBLIC_AUTH_TEMPLATE), component=component)


def _api_key_header_value(
    header_name: str,
    key: str,
    *,
    use_bearer: bool | None = None,
) -> str:
    header = (header_name or "Authorization").strip() or "Authorization"
    if header.lower() != "authorization":
        return key
    lower = key.lower()
    if lower.startswith("bearer ") or lower.startswith("basic "):
        return key
    if use_bearer is False:
        return key
    if use_bearer is True or use_bearer is None:
        return f"Bearer {key}"
    return key


def save_api_key_auth(
    site: str,
    api_key: str,
    *,
    component: str | None = None,
    header_name: str = "Authorization",
    scheme: str = "Bearer",
    use_bearer: bool | None = None,
    query_param_name: str = "",
) -> Path:
    """Save target API key in auth headers and/or query_params."""
    key = (api_key or "").strip()
    if not key:
        raise ValueError("API key is required")
    header = (header_name or "").strip()
    qparam = (query_param_name or "").strip()
    headers: dict[str, str] = {}
    query_params: dict[str, str] = {}
    if header:
        bearer = use_bearer
        if bearer is None and header.lower() == "authorization":
            bearer = True
        headers[header] = _api_key_header_value(header, key, use_bearer=bearer)
    if qparam:
        query_params[qparam] = key
    if not headers and not query_params:
        headers["Authorization"] = _api_key_header_value("Authorization", key, use_bearer=True)
    config = {
        "cookies": [],
        "origins": [],
        "headers": headers,
        "query_params": query_params,
        "auth_mode": "api_key",
    }
    return save_auth_config(site, config, component=component)


def has_target_api_key(site: str, component: str | None = None) -> bool:
    """True when auth.json stores a target API key."""
    config = load_auth_config(site, component)
    if not config or config.get("auth_mode") != "api_key":
        return False
    return bool(config.get("headers") or config.get("query_params"))


def auth_status_payload(site: str, component: str | None = None) -> dict[str, Any]:
    """Non-secret auth status for API responses."""
    if not auth_config_exists(site, component):
        return {
            "configured": False,
            "mode": None,
            "scope": "none",
            "has_api_key": False,
            "auth_header": "",
            "auth_query_param": "",
            "use_bearer": False,
        }
    cfg = load_auth_config(site, component) or {}
    headers = cfg.get("headers") or {}
    query_params = cfg.get("query_params") or {}
    auth_header = next(iter(headers.keys()), "") if headers else ""
    auth_query_param = next(iter(query_params.keys()), "") if query_params else ""
    use_bearer = False
    if auth_header.lower() == "authorization":
        val = str(headers.get(auth_header) or "")
        use_bearer = bool(val) and val.lower().startswith("bearer ")
    return {
        "configured": is_auth_configured(site, component),
        "mode": auth_mode_for_domain(site, component),
        "scope": resolve_auth_scope(site, component),
        "has_api_key": has_target_api_key(site, component),
        "auth_header": auth_header,
        "auth_query_param": auth_query_param,
        "use_bearer": use_bearer,
    }


def clean_auth_storage(
    site: str,
    component: str | None = None,
    max_value_len: int | None = None,
) -> tuple[bool, str]:
    """
    Strip localStorage/sessionStorage items with value length > max_value_len.
    Re-saves auth.json. Returns (success, message).
    """
    from browser_bot.config import LOCALSTORAGE_MAX_VALUE_LEN

    max_len = max_value_len if max_value_len is not None else LOCALSTORAGE_MAX_VALUE_LEN
    scope = resolve_auth_scope(site, component)
    config = load_auth_config(site, component)
    if not config:
        label = f"{site}/{component}" if component else site
        return False, f"No auth.json for {label}"

    def _filter(items: list) -> list:
        return [i for i in items if len(str(i.get("value", ""))) <= max_len]

    removed = 0
    for origin in config.get("origins", []):
        ls = origin.get("localStorage", [])
        ss = origin.get("sessionStorage", [])
        new_ls = _filter(ls)
        new_ss = _filter(ss)
        removed += (len(ls) - len(new_ls)) + (len(ss) - len(new_ss))
        origin["localStorage"] = new_ls
        origin["sessionStorage"] = new_ss

    if removed == 0:
        return True, f"No items over {max_len} chars to remove."
    write_component = component if scope == "component" else None
    save_auth_config(site, config, component=write_component)
    return True, f"Removed {removed} items (value > {max_len} chars)."
