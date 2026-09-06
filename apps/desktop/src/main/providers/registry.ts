/**
 * The agent-provider registry is now the catalog in @hivemind/agents: every
 * provider is ONE def file (+ its node half) and one catalog line. This module
 * keeps the daemon's import path and the registry tests' surface.
 */
export { PROVIDERS, providerFor, composeResume, composeResumeFrom, prepareProviders, type ComposedResume, type AgentProvider } from "@hivemind/agents/node";
