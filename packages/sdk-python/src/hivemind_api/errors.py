"""The one error a call, or connecting, fails with: the host's code and message."""


class ApiError(Exception):
    """A call or a hello that failed. ``code`` is the host's (``FORBIDDEN``, ``NOT_FOUND``,
    ``BAD_REQUEST``, ...) or the client's own (``UNAVAILABLE``: no host, or the connection closed;
    ``TIMEOUT``: no answer in time). A code from a newer host is kept as it was sent."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    def __repr__(self) -> str:
        return f"ApiError({self.code!r}, {self.message!r})"
