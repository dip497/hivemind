/**
 * hivemind-api: drive a Hivemind workspace from a program through the drive socket, with a token
 * (spec/workspace-api.md "Drive socket").
 */
export { connect, HiveClient, type ConnectOptions } from "./client.js";
export type { CallOptions, Identity } from "./connection.js";
export { defaultToken, defaultWorkspace, driveSocketPath, type Where } from "./places.js";
export { ApiError, type ErrorCode } from "@hivemind/workspace-api/protocol";
export type { Event, EventParams, Method, Notice, NoticeParams, Params, Result } from "@hivemind/workspace-api/methods";
export type { AgentAnswer, AgentEvent, AgentItem, AgentRead, StartAgent } from "@hivemind/workspace-api/agents";
export type { FrameClose, FrameClosed, FrameOpened, FrameSpec } from "@hivemind/workspace-api/frames";
