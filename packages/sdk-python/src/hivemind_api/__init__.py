"""hivemind-api: drive a Hivemind workspace from a program through the drive socket, with a token
(spec/workspace-api.md "Drive socket").

    from hivemind_api import connect

    with connect() as hive:
        print(hive.agents.list()["agents"])
"""

from .client import Client, connect
from .errors import ApiError
from .places import default_token, default_workspace, drive_socket_path

__all__ = ["ApiError", "Client", "connect", "default_token", "default_workspace", "drive_socket_path"]
__version__ = "2026.10.3"
