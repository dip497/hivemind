"""Where a program finds the drive socket and who it is when it is not told, as the app and the
``hive`` CLI find them: ``HIVE_DRIVE_SOCK``, ``HCP_TOKEN``, ``HIVE_DRIVE_TOKEN``, ``HIVE_WORKSPACE``,
else the app's data folder on this machine."""

import hashlib
import ntpath
import os
import posixpath
import sys
from typing import Mapping, Optional


def _env_get(env: Mapping[str, str], name: str) -> Optional[str]:
    # On Windows a variable keeps whatever case its creator gave it.
    if name in env:
        return env[name]
    for key, value in env.items():
        if key.lower() == name.lower():
            return value
    return None


def _platform_name(platform: Optional[str]) -> str:
    """The platform as Node names it: win32, darwin or linux."""
    p = platform or sys.platform
    return "darwin" if p == "darwin" else "win32" if p.startswith("win") else p


def app_data_folder(platform: Optional[str] = None, env: Optional[Mapping[str, str]] = None) -> str:
    """The app's data folder: ``HIVEMIND_APP_DATA``, else where the app keeps it on this platform."""
    env = os.environ if env is None else env
    platform = _platform_name(platform)
    named = _env_get(env, "HIVEMIND_APP_DATA")
    if named:
        return named
    home = os.path.expanduser("~")
    if platform == "win32":
        roaming = _env_get(env, "APPDATA")
        return ntpath.join(roaming, "hivemind") if roaming else ntpath.join(home, "AppData", "Roaming", "hivemind")
    if platform == "darwin":
        return posixpath.join(home, "Library", "Application Support", "hivemind")
    return posixpath.join(env.get("XDG_CONFIG_HOME") or posixpath.join(home, ".config"), "hivemind")


def drive_socket_path(platform: Optional[str] = None, env: Optional[Mapping[str, str]] = None) -> str:
    """``HIVE_DRIVE_SOCK``, else ``drive.sock`` in the app's data folder; on Windows the app's named
    pipe, named from a hash of that folder."""
    env = os.environ if env is None else env
    given = _env_get(env, "HIVE_DRIVE_SOCK")
    if given:
        return given
    folder = app_data_folder(platform, env)
    if _platform_name(platform) != "win32":
        return posixpath.join(folder, "drive.sock")
    key = hashlib.sha256(ntpath.normpath(folder).encode("utf-8")).hexdigest()[:12]
    return "\\\\.\\pipe\\hivemind-" + key + "-drive"


def default_token(platform: Optional[str] = None, env: Optional[Mapping[str, str]] = None) -> str:
    """``HCP_TOKEN`` (an agent's own), ``HIVE_DRIVE_TOKEN`` (a grant's), else the person's token on
    this machine; "" when there is none."""
    env = os.environ if env is None else env
    given = _env_get(env, "HCP_TOKEN") or _env_get(env, "HIVE_DRIVE_TOKEN")
    if given:
        return given
    try:
        with open(os.path.join(app_data_folder(platform, env), "hcp.token"), encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def default_workspace(env: Optional[Mapping[str, str]] = None) -> Optional[str]:
    """The workspace a program drives when it names none: ``HIVE_WORKSPACE``."""
    return _env_get(os.environ if env is None else env, "HIVE_WORKSPACE") or None
