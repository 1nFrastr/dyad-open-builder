/**
 * ACP Agent Handler
 *
 * Handles chat streaming using an external ACP-compatible agent runtime
 * (e.g. claude-agent-acp, opencode, codex-acp).
 *
 * Replaces the internal local_agent_handler for "acp-agent" chat mode.
 * The frontend (React hooks, IPC layer) remains completely unchanged.
 */

import { IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import { v4 as uuidv4 } from "uuid";

import { db } from "@/db";
import { chats, messages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getDyadAppPath } from "@/paths/paths";
import { safeSend } from "@/ipc/utils/safe_sender";

import type { ChatStreamParams, ChatResponseEnd } from "@/ipc/types";
import type { UserSettings } from "@/lib/schemas";

import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  ReadTextFileRequest,
  WriteTextFileRequest,
  SessionNotification,
} from "@agentclientprotocol/sdk";

import { AcpSessionManager, acpSessionCache } from "./acp_session_manager";
import type { DyadClientHandlers } from "./acp_session_manager";
import { AcpSessionTranslator, planEntriesToTodos } from "./acp_translator";
import { handleReadTextFile, handleWriteTextFile } from "./acp_fs_bridge";
import type { AcpAgentConfig, AcpAgentType } from "./acp_types";

const logger = log.scope("acp_agent_handler");

// =============================================================================
// Main Handler
// =============================================================================

/**
 * Handle a chat stream using an external ACP-compatible agent.
 */
export async function handleAcpAgentStream(
  event: IpcMainInvokeEvent,
  req: ChatStreamParams,
  abortController: AbortController,
  options: { placeholderMessageId: number },
  settings: UserSettings,
): Promise<void> {
  const { placeholderMessageId } = options;

  // Load chat and app info from DB
  const chat = await db.query.chats.findFirst({
    where: eq(chats.id, req.chatId),
    with: {
      messages: {
        orderBy: (msgs, { asc }) => [asc(msgs.createdAt)],
      },
      app: true,
    },
  });

  if (!chat || !chat.app) {
    safeSend(event.sender, "chat:response:error", {
      chatId: req.chatId,
      error: `Chat not found: ${req.chatId}`,
    });
    return;
  }

  const appPath = getDyadAppPath(chat.app.path);

  // Send initial chunk so loading state shows in the UI
  safeSend(event.sender, "chat:response:chunk", {
    chatId: req.chatId,
    messages: chat.messages,
  });

  // -------------------------------------------------------------------------
  // Get or create an ACP session for this chat
  // -------------------------------------------------------------------------

  let manager: AcpSessionManager;
  let sessionId: string;

  const agentConfig = resolveAgentConfig(settings);
  const existing = acpSessionCache.get(req.chatId);

  if (existing && existing.manager.isRunning) {
    manager = existing.manager;
    sessionId = existing.sessionId;
    logger.log(`Reusing ACP session ${sessionId} for chat ${req.chatId}`);
  } else {
    manager = new AcpSessionManager(appPath, agentConfig);

    try {
      await manager.start();
    } catch (err) {
      const errorMsg = `Failed to start ACP agent: ${(err as Error).message}`;
      logger.error(errorMsg);
      safeSend(event.sender, "chat:response:error", {
        chatId: req.chatId,
        error: errorMsg,
      });
      return;
    }

    try {
      sessionId = await manager.createSession();
      acpSessionCache.set(req.chatId, manager, sessionId);
      logger.log(`Created ACP session ${sessionId} for chat ${req.chatId}`);
    } catch (err) {
      const errorMsg = `Failed to create ACP session: ${(err as Error).message}`;
      logger.error(errorMsg);
      manager.stop();
      safeSend(event.sender, "chat:response:error", {
        chatId: req.chatId,
        error: errorMsg,
      });
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  const onAbort = () => {
    logger.log(`Cancelling ACP session ${sessionId}`);
    manager.cancel(sessionId);
  };
  abortController.signal.addEventListener("abort", onAbort, { once: true });

  // -------------------------------------------------------------------------
  // Per-prompt state
  // -------------------------------------------------------------------------

  let fullResponse = "";
  const translator = new AcpSessionTranslator(appPath);

  const flushToFrontend = async (newContent: string) => {
    if (!newContent) return;
    fullResponse += newContent;

    await db
      .update(messages)
      .set({ content: fullResponse })
      .where(eq(messages.id, placeholderMessageId))
      .catch((err) => logger.error("Failed to update message in DB:", err));

    const currentMessages = [...chat.messages];
    const placeholderMsg = currentMessages.find(
      (m) => m.id === placeholderMessageId,
    );
    if (placeholderMsg) placeholderMsg.content = fullResponse;

    safeSend(event.sender, "chat:response:chunk", {
      chatId: req.chatId,
      messages: currentMessages,
    });
  };

  // -------------------------------------------------------------------------
  // Build DyadClientHandlers for this prompt turn
  // -------------------------------------------------------------------------

  const handlers: DyadClientHandlers = {
    onSessionUpdate: (notification: SessionNotification) => {
      const update = notification.update;

      if (update.sessionUpdate === "plan") {
        const todos = planEntriesToTodos(update);
        safeSend(event.sender, "agent-tool:todos-update", {
          chatId: req.chatId,
          todos,
        });
      }

      const newContent = translator.translateNotification(notification);
      if (newContent) {
        flushToFrontend(newContent).catch((err) =>
          logger.error("Error flushing to frontend:", err),
        );
      }
    },

    onRequestPermission: async (
      permParams: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> => {
      if (abortController.signal.aborted) {
        return { outcome: { outcome: "cancelled" } };
      }

      const requestId = uuidv4();
      const toolCallId = permParams.toolCall.toolCallId;

      const allowOnceOption = permParams.options.find(
        (o) => o.kind === "allow_once",
      );
      const allowAlwaysOption = permParams.options.find(
        (o) => o.kind === "allow_always",
      );
      const rejectOption = permParams.options.find(
        (o) => o.kind === "reject_once" || o.kind === "reject_always",
      );

      safeSend(event.sender, "agent-tool:consent-request", {
        requestId,
        chatId: req.chatId,
        toolName: toolCallId,
        inputPreview: permParams.toolCall.title ?? toolCallId,
      });

      return new Promise<RequestPermissionResponse>((resolve) => {
        const timeoutId = setTimeout(() => {
          cleanup();
          resolve({
            outcome: allowOnceOption
              ? { outcome: "selected", optionId: allowOnceOption.optionId }
              : { outcome: "cancelled" },
          });
        }, 60000);

        const onAbortConsent = () => {
          cleanup();
          resolve({ outcome: { outcome: "cancelled" } });
        };
        abortController.signal.addEventListener("abort", onAbortConsent, {
          once: true,
        });

        acpConsentResponders.set(requestId, (decision: string) => {
          cleanup();
          if (decision === "accept-once" || decision === "accept-always") {
            const option =
              decision === "accept-always" && allowAlwaysOption
                ? allowAlwaysOption
                : allowOnceOption;
            resolve({
              outcome: option
                ? { outcome: "selected", optionId: option.optionId }
                : { outcome: "cancelled" },
            });
          } else {
            resolve({
              outcome: rejectOption
                ? { outcome: "selected", optionId: rejectOption.optionId }
                : { outcome: "cancelled" },
            });
          }
        });

        function cleanup() {
          clearTimeout(timeoutId);
          abortController.signal.removeEventListener("abort", onAbortConsent);
          acpConsentResponders.delete(requestId);
        }
      });
    },

    onReadTextFile: async (params: ReadTextFileRequest) => {
      return handleReadTextFile(params, appPath);
    },

    onWriteTextFile: async (params: WriteTextFileRequest) => {
      return handleWriteTextFile(params, appPath);
    },
  };

  // -------------------------------------------------------------------------
  // Send the prompt
  // -------------------------------------------------------------------------

  let wasCancelled = false;

  try {
    const result = await manager.prompt(sessionId, req.prompt, handlers);
    wasCancelled = result.stopReason === "cancelled";
    logger.log(`ACP prompt completed: stopReason=${result.stopReason}`);
  } catch (err) {
    logger.error("ACP prompt error:", err);
    if (!abortController.signal.aborted) {
      safeSend(event.sender, "chat:response:error", {
        chatId: req.chatId,
        error: `Agent error: ${(err as Error).message}`,
      });
    }
  } finally {
    abortController.signal.removeEventListener("abort", onAbort);
  }

  // Final DB write
  await db
    .update(messages)
    .set({ content: fullResponse })
    .where(eq(messages.id, placeholderMessageId))
    .catch((err) => logger.error("Final DB write failed:", err));

  const endPayload: ChatResponseEnd = {
    chatId: req.chatId,
    updatedFiles:
      fullResponse.includes("<dyad-write") ||
      fullResponse.includes("<dyad-search-replace") ||
      fullResponse.includes("<dyad-edit"),
    wasCancelled,
  };

  safeSend(event.sender, "chat:response:end", endPayload);
}

// =============================================================================
// Consent Response Bridge
// =============================================================================

export const acpConsentResponders = new Map<
  string,
  (decision: string) => void
>();

// =============================================================================
// Agent Config Resolution
// =============================================================================

function resolveAgentConfig(settings: UserSettings): AcpAgentConfig {
  const agentType = (settings.acpAgentType as AcpAgentType) ?? "claude-code";
  return {
    agentType,
    executablePath: settings.acpAgentExecutablePath as string | undefined,
    env: buildAgentEnv(settings),
  };
}

function buildAgentEnv(settings: UserSettings): Record<string, string> {
  const env: Record<string, string> = {};

  const anthropicKey = settings.providerSettings?.anthropic?.apiKey?.value;
  if (anthropicKey) env.ANTHROPIC_API_KEY = anthropicKey;

  const openaiKey = settings.providerSettings?.openai?.apiKey?.value;
  if (openaiKey) env.OPENAI_API_KEY = openaiKey;

  const googleKey = settings.providerSettings?.google?.apiKey?.value;
  if (googleKey) env.GOOGLE_API_KEY = googleKey;

  return env;
}
