/**
 * ACP Session Manager
 *
 * Manages ACP agent subprocesses and sessions using the official
 * @agentclientprotocol/sdk ClientSideConnection.
 *
 * The SDK handles all JSON-RPC protocol details, version negotiation,
 * and message routing. We only need to:
 *  - Spawn the agent subprocess
 *  - Convert stdin/stdout to Web streams
 *  - Implement the Client interface (sessionUpdate, requestPermission, fs)
 */

import { spawn } from "child_process";
import { Writable, Readable } from "stream";
import log from "electron-log";

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

import type {
  AcpAgentConfig,
  AcpAgentType,
} from "./acp_types";
import {
  ACP_AGENT_EXECUTABLES,
  ACP_AGENT_DEFAULT_ARGS,
} from "./acp_types";

const logger = log.scope("acp_session_manager");

// =============================================================================
// Dyad Client implementation (the "Client" side of ACP)
// =============================================================================

export interface DyadClientHandlers {
  onSessionUpdate: (params: SessionNotification) => void;
  onRequestPermission: (
    params: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>;
  onReadTextFile: (
    params: ReadTextFileRequest,
  ) => Promise<ReadTextFileResponse>;
  onWriteTextFile: (
    params: WriteTextFileRequest,
  ) => Promise<WriteTextFileResponse>;
}

const noopHandlers: DyadClientHandlers = {
  onSessionUpdate: () => {},
  onRequestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  onReadTextFile: async () => ({ content: "" }),
  onWriteTextFile: async () => ({}),
};

/**
 * Implements the ACP Client interface.
 *
 * Delegates to a mutable handlers reference so we can update handlers per-prompt
 * without recreating the connection (the SDK creates one DyadClient per connection).
 */
class DyadClient implements Client {
  constructor(private getHandlers: () => DyadClientHandlers) {}

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.getHandlers().onSessionUpdate(params);
  }

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return this.getHandlers().onRequestPermission(params);
  }

  async readTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    return this.getHandlers().onReadTextFile(params);
  }

  async writeTextFile(
    params: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    return this.getHandlers().onWriteTextFile(params);
  }
}

// =============================================================================
// ACP Session Manager
// =============================================================================

export class AcpSessionManager {
  private connection: ClientSideConnection | null = null;
  private agentProcess: ReturnType<typeof spawn> | null = null;
  private sessionId: string | null = null;
  private initialized = false;
  /** Mutable handlers updated per prompt call */
  private currentHandlers: DyadClientHandlers = noopHandlers;

  constructor(
    private workingDirectory: string,
    private config: AcpAgentConfig,
  ) {}

  // =============================================================================
  // Lifecycle
  // =============================================================================

  async start(): Promise<void> {
    if (this.agentProcess) {
      logger.warn("ACP agent process already running");
      return;
    }

    const executable = this.resolveExecutable();
    const args = this.resolveArgs();

    logger.log(`Starting ACP agent: ${executable} ${args.join(" ")}`);
    logger.log(`Working directory: ${this.workingDirectory}`);

    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined) as [
          string,
          string,
        ][],
      ),
      // Augment PATH with common Node.js global binary locations so the agent
      // can be found even when Dyad is launched from a GUI (not a terminal).
      PATH: [
        process.env.PATH ?? "",
        "/usr/local/bin",
        "/opt/homebrew/bin",
        `${process.env.HOME ?? ""}/.nvm/versions/node/current/bin`,
        `${process.env.HOME ?? ""}/.volta/bin`,
        `${process.env.HOME ?? ""}/.fnm/aliases/default/bin`,
        `${process.env.HOME ?? ""}/Library/pnpm`,
        "/usr/local/lib/node_modules/.bin",
      ]
        .filter(Boolean)
        .join(":"),
      ...this.config.env,
    };

    this.agentProcess = spawn(executable, args, {
      cwd: this.workingDirectory,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.agentProcess.on("error", (err) => {
      logger.error("ACP agent process error:", err);
    });

    this.agentProcess.on("exit", (code, signal) => {
      logger.log(`ACP agent process exited: code=${code}, signal=${signal}`);
      this.agentProcess = null;
      this.connection = null;
      this.initialized = false;
    });

    if (this.agentProcess.stderr) {
      this.agentProcess.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) logger.log(`[acp-agent stderr] ${text}`);
      });
    }

    // Convert Node.js streams to Web streams for the SDK
    const writableWeb = Writable.toWeb(this.agentProcess.stdin!);
    const readableWeb = Readable.toWeb(
      this.agentProcess.stdout!,
    ) as ReadableStream<Uint8Array>;

    // Create the SDK connection.
    // DyadClient delegates to this.currentHandlers, which we update per-prompt.
    const stream = ndJsonStream(writableWeb, readableWeb);
    this.connection = new ClientSideConnection(
      (_agent) => new DyadClient(() => this.currentHandlers),
      stream,
    );

    // Initialize the ACP connection (version negotiation + capabilities)
    const initResult = await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
      clientInfo: {
        name: "dyad",
        title: "Dyad",
        version: "1.0.0",
      },
    });

    logger.log(
      `ACP initialized: protocol v${initResult.protocolVersion}, agent: ${initResult.agentInfo?.name ?? "unknown"}`,
    );
    this.initialized = true;
  }

  async createSession(): Promise<string> {
    this.ensureInitialized();
    const result = await this.connection!.newSession({
      cwd: this.workingDirectory,
      mcpServers: [],
    });
    this.sessionId = result.sessionId;
    logger.log(`ACP session created: ${this.sessionId}`);
    return this.sessionId;
  }

  async prompt(
    sessionId: string,
    userPrompt: string,
    handlers: DyadClientHandlers,
  ): Promise<{ stopReason: string }> {
    this.ensureInitialized();
    this.currentHandlers = handlers;
    try {
      const result = await this.connection!.prompt({
        sessionId,
        prompt: [{ type: "text", text: userPrompt }],
      });
      return { stopReason: result.stopReason };
    } finally {
      this.currentHandlers = noopHandlers;
    }
  }

  cancel(sessionId: string): void {
    if (!this.connection) return;
    this.connection.cancel({ sessionId }).catch((err) => {
      logger.error("Error cancelling ACP session:", err);
    });
  }

  stop(): void {
    if (!this.agentProcess) return;
    logger.log("Stopping ACP agent process");
    try {
      this.agentProcess.stdin?.end();
      this.agentProcess.kill("SIGTERM");
    } catch (err) {
      logger.error("Error stopping ACP agent process:", err);
    }
  }

  get isRunning(): boolean {
    return this.agentProcess !== null && !this.agentProcess.killed;
  }

  // =============================================================================
  // Helpers
  // =============================================================================

  private ensureInitialized(): void {
    if (!this.initialized || !this.connection) {
      throw new Error(
        "ACP session manager not initialized. Call start() first.",
      );
    }
  }

  private resolveExecutable(): string {
    if (this.config.executablePath) {
      return this.config.executablePath;
    }
    const name = ACP_AGENT_EXECUTABLES[this.config.agentType];
    if (!name) {
      throw new Error(
        `No executable configured for ACP agent type: ${this.config.agentType}`,
      );
    }
    return name;
  }

  private resolveArgs(): string[] {
    const defaultArgs =
      ACP_AGENT_DEFAULT_ARGS[this.config.agentType as AcpAgentType] ?? [];
    return [...defaultArgs, ...(this.config.extraArgs ?? [])];
  }
}

// =============================================================================
// Per-Chat Session Cache
// =============================================================================

/**
 * Caches AcpSessionManager instances and ACP session IDs per chat.
 * Allows reusing the same agent process and session across multiple messages.
 */
class AcpSessionCache {
  private sessions = new Map<
    number,
    { manager: AcpSessionManager; sessionId: string }
  >();

  get(
    chatId: number,
  ): { manager: AcpSessionManager; sessionId: string } | undefined {
    return this.sessions.get(chatId);
  }

  set(
    chatId: number,
    manager: AcpSessionManager,
    sessionId: string,
  ): void {
    this.sessions.set(chatId, { manager, sessionId });
  }

  delete(chatId: number): void {
    const existing = this.sessions.get(chatId);
    if (existing) {
      existing.manager.stop();
      this.sessions.delete(chatId);
    }
  }

  clear(): void {
    for (const chatId of this.sessions.keys()) {
      this.delete(chatId);
    }
  }
}

export const acpSessionCache = new AcpSessionCache();
