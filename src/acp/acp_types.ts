/**
 * ACP type re-exports and Dyad-specific configuration types.
 *
 * Protocol types come directly from @agentclientprotocol/sdk.
 * We only define what's specific to Dyad's ACP integration here.
 */

export type {
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  PromptRequest,
  PromptResponse,
  NewSessionRequest,
  NewSessionResponse,
  InitializeRequest,
  InitializeResponse,
  CancelNotification,
  Client,
} from "@agentclientprotocol/sdk";

export { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

// =============================================================================
// Dyad ACP Agent Configuration
// =============================================================================

/** Which external ACP-compatible agent to use */
export type AcpAgentType =
  | "claude-code"
  | "opencode"
  | "codex"
  | "copilot"
  | "gemini"
  | "custom";

export interface AcpAgentConfig {
  agentType: AcpAgentType;
  /** Executable path - auto-detected if not specified */
  executablePath?: string;
  /** Extra CLI arguments to pass to the agent process */
  extraArgs?: string[];
  /** Environment variables to set for the agent process */
  env?: Record<string, string>;
}

/** Default executable names per agent type */
export const ACP_AGENT_EXECUTABLES: Record<AcpAgentType, string> = {
  "claude-code": "claude-agent-acp",
  opencode: "opencode",
  codex: "codex-acp",
  copilot: "gh",
  gemini: "gemini",
  custom: "",
};

/** Default extra args per agent type */
export const ACP_AGENT_DEFAULT_ARGS: Partial<Record<AcpAgentType, string[]>> =
  {
    copilot: ["copilot", "acp"],
  };
