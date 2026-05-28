"""Subprocess wrapper for login - opens a browser, user logs in, auth state is saved."""
import asyncio
import sys
from pathlib import Path

_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_root / "browser-bot"))

from browser_bot.auth import capture_login  # noqa: E402

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python login_worker.py <site> <component> <url>", file=sys.stderr)
        print("   or: python login_worker.py <url>", file=sys.stderr)
        sys.exit(1)
    if len(sys.argv) >= 4:
        site = sys.argv[1].strip()
        component = sys.argv[2].strip()
        url = sys.argv[3].strip()
    else:
        site = ""
        component = ""
        url = sys.argv[1].strip()
    if not url or url.startswith("{"):
        print("[!] Invalid login URL", file=sys.stderr)
        sys.exit(1)
    target = asyncio.run(
        capture_login(
            url,
            site=site or None,
            component=component or None,
        )
    )
    if target:
        scope = f"{site}/{component}" if site and component else site or target
        print(f"[+] Auth saved for {scope}")
        sys.exit(0)
    print("[!] Login failed or cancelled")
    sys.exit(1)
