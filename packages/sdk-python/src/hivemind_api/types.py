"""The shapes the common jobs answer with, as spec/workspace-api.md and spec/agents.md give them
(their TypeScript source is packages/workspace-api/src/agents.ts and frames.ts). A host may add
fields; these name the ones a program reads most."""

from typing import Any, Dict, List, Optional, TypedDict


class Waiting(TypedDict, total=False):
    """What an agent waits for: ``since`` is the wait ``agents.answer`` names."""

    kind: str
    since: int
    says: str
    plan: str
    decide: bool
    approval: Dict[str, Any]
    tool: Dict[str, Any]
    asks: List[Dict[str, Any]]


class AgentItem(TypedDict, total=False):
    workspace: str
    name: str
    tile: str
    agent: str
    program: Dict[str, str]
    state: str
    since: int
    machine: str
    waiting: Waiting
    parent: str
    session: str


class AgentList(TypedDict):
    seq: int
    agents: List[AgentItem]


class AgentEvent(TypedDict, total=False):
    seq: int
    at: int
    kind: str
    tile: str
    detail: str


class AgentSince(TypedDict):
    seq: int
    changes: List[Dict[str, Any]]
    events: List[AgentEvent]


class StartAgent(TypedDict, total=False):
    program: str
    frame: str
    folder: str
    prompt: str
    model: str
    mode: str
    name: str
    resume: str
    report: bool


class Started(TypedDict):
    tile: str


class AgentRead(TypedDict, total=False):
    text: Optional[str]
    finalStatus: str
    truncated: bool
    note: str
    waiting: Waiting
    awaiting: int


class Answered(TypedDict, total=False):
    answered: bool
    by: Dict[str, str]


class FrameSpec(TypedDict, total=False):
    path: str
    machine: str
    worktree: Dict[str, str]
    title: str
    parent: str


class FrameOpened(TypedDict):
    frame: str
    path: str
    opened: bool
    created: bool


class FrameClosed(TypedDict):
    closed: List[str]
    tilesClosed: int
    worktreeRemoved: bool
