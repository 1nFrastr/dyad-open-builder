/**
 * ACP → Dyad Event Translator
 *
 * Converts ACP SessionUpdate notifications (from the SDK's SessionNotification)
 * into Dyad's message format (<dyad-*> XML tags embedded in message content).
 *
 * This keeps the frontend completely unchanged while allowing external ACP agents
 * to power the underlying execution.
 */

import path from "node:path";
import { escapeXmlAttr, escapeXmlContent } from "../../shared/xmlEscape";
import type {
  SessionNotification,
  SessionUpdate,
  ToolCall,
  ToolCallUpdate,
  Plan,
  ContentChunk,
  Diff,
  ToolCallContent,
  ToolCallStatus,
} from "@agentclientprotocol/sdk";
import log from "electron-log";
import type { AgentTodo } from "@/ipc/types";

const logger = log.scope("acp_translator");

// =============================================================================
// In-Progress Tool Call State
// =============================================================================

interface ToolCallState {
  toolCallId: string;
  kind?: string;
  title?: string;
  status: ToolCallStatus;
  /** Whether the XML tag has been closed */
  closed: boolean;
  /** Whether this tool call emitted a write-style open tag (needs explicit close) */
  needsClose: boolean;
}

// =============================================================================
// ACP Session Translator
// =============================================================================

/**
 * Translates ACP SessionUpdate events into Dyad's XML/text message format.
 *
 * Call `translateNotification()` for each incoming session/update notification.
 * Returns the new content fragment to append to the current message.
 */
export class AcpSessionTranslator {
  private accumulatedContent = "";
  private toolCallStates = new Map<string, ToolCallState>();

  /**
   * @param workspaceRoot  The app's absolute directory. Absolute paths from the
   *                       agent are made relative to this before being embedded
   *                       in XML tags, because Dyad's safeJoin rejects absolute paths.
   */
  constructor(private workspaceRoot: string = "") {}

  /**
   * Convert an agent-supplied path to a workspace-relative path.
   * If the path is already relative, or workspaceRoot is unknown, it is returned as-is.
   */
  private relativize(agentPath: string): string {
    if (!this.workspaceRoot || !path.isAbsolute(agentPath)) {
      return agentPath;
    }
    const rel = path.relative(this.workspaceRoot, agentPath);
    // If relativization escapes the workspace (starts with ".."), keep the
    // basename only as a last resort so we never emit an absolute path.
    if (rel.startsWith("..")) {
      return path.basename(agentPath);
    }
    return rel;
  }

  translateNotification(notification: SessionNotification): string {
    return this.translateUpdate(notification.update);
  }

  translateUpdate(update: SessionUpdate): string {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return this.translateMessageChunk(update as ContentChunk & { sessionUpdate: "agent_message_chunk" });

      case "agent_thought_chunk":
        return this.translateThoughtChunk(update as ContentChunk & { sessionUpdate: "agent_thought_chunk" });

      case "tool_call":
        return this.translateToolCall(update as ToolCall & { sessionUpdate: "tool_call" });

      case "tool_call_update":
        return this.translateToolCallUpdate(update as ToolCallUpdate & { sessionUpdate: "tool_call_update" });

      case "plan":
        return this.translatePlan(update as Plan & { sessionUpdate: "plan" });

      default:
        return "";
    }
  }

  getAccumulatedContent(): string {
    return this.accumulatedContent;
  }

  private append(content: string): string {
    this.accumulatedContent += content;
    return content;
  }

  // =============================================================================
  // agent_message_chunk → plain text
  // =============================================================================

  private translateMessageChunk(update: ContentChunk & { sessionUpdate: "agent_message_chunk" }): string {
    if (update.content.type !== "text") return "";
    return this.append(update.content.text);
  }

  // =============================================================================
  // agent_thought_chunk → <think> tag
  // =============================================================================

  private translateThoughtChunk(update: ContentChunk & { sessionUpdate: "agent_thought_chunk" }): string {
    if (update.content.type !== "text") return "";
    const xml = `\n<think>${escapeXmlContent(update.content.text)}</think>\n`;
    return this.append(xml);
  }

  // =============================================================================
  // tool_call → <dyad-*> opening tag
  // =============================================================================

  private translateToolCall(update: ToolCall & { sessionUpdate: "tool_call" }): string {
    const state: ToolCallState = {
      toolCallId: update.toolCallId,
      kind: update.kind,
      title: update.title,
      status: update.status ?? "pending",
      closed: false,
      needsClose: false,
    };
    this.toolCallStates.set(update.toolCallId, state);

    let xml = this.buildOpeningXml(update, state);

    // If content already comes with the initial tool_call (e.g. diffs)
    if (update.content?.length) {
      for (const item of update.content) {
        xml += this.contentItemToXml(item);
      }
    }

    // If this is a terminal status already
    if (
      update.status === "completed" ||
      update.status === "failed"
    ) {
      state.closed = true;
      if (state.needsClose) xml += this.buildClosingTag(state);
    }

    if (!xml) return "";
    return this.append(xml);
  }

  // =============================================================================
  // tool_call_update → update / close existing tag
  // =============================================================================

  private translateToolCallUpdate(update: ToolCallUpdate & { sessionUpdate: "tool_call_update" }): string {
    const state = this.toolCallStates.get(update.toolCallId);
    if (!state) {
      logger.warn("tool_call_update for unknown toolCallId:", update.toolCallId);
      return "";
    }

    if (update.status) state.status = update.status;

    let xml = "";

    if (update.content?.length) {
      for (const item of update.content) {
        xml += this.contentItemToXml(item);
      }
    }

    const isTerminal =
      update.status === "completed" || update.status === "failed";

    if (isTerminal && !state.closed) {
      state.closed = true;
      if (state.needsClose) xml += this.buildClosingTag(state);
    }

    if (!xml) return "";
    return this.append(xml);
  }

  // =============================================================================
  // plan → <dyad-status> + todos
  // =============================================================================

  private translatePlan(update: Plan & { sessionUpdate: "plan" }): string {
    const inProgress = update.entries.filter(
      (e) => e.status === "in_progress",
    ).length;
    const pending = update.entries.filter((e) => e.status === "pending").length;
    const done = update.entries.filter((e) => e.status === "completed").length;

    const parts = [
      inProgress > 0 ? `${inProgress} in progress` : null,
      pending > 0 ? `${pending} pending` : null,
      done > 0 ? `${done} done` : null,
    ].filter(Boolean);

    if (!parts.length) return "";
    const xml = `\n<dyad-status type="info">${escapeXmlContent(parts.join(", "))}</dyad-status>\n`;
    return this.append(xml);
  }

  // =============================================================================
  // Builders
  // =============================================================================

  private buildOpeningXml(
    update: ToolCall & { sessionUpdate: "tool_call" },
    state: ToolCallState,
  ): string {
    const kind = update.kind ?? "other";
    const title = update.title ?? "";
    const filePath = update.locations?.[0]?.path ?? "";

    switch (kind) {
      case "read": {
        if (!filePath) return "";
        state.needsClose = true;
        return `\n<dyad-read path="${escapeXmlAttr(this.relativize(filePath))}">`;
      }

      case "edit": {
        // Diffs come in tool_call content or tool_call_update content
        // If no path yet, wait for the update
        if (!filePath) return "";
        state.needsClose = true;
        return `\n<dyad-write path="${escapeXmlAttr(this.relativize(filePath))}" description="${escapeXmlAttr(title)}">`;
      }

      case "delete": {
        if (!filePath) return "";
        state.needsClose = true;
        return `\n<dyad-delete path="${escapeXmlAttr(this.relativize(filePath))}">`;
      }

      case "move": {
        const toPath = update.locations?.[1]?.path ?? title;
        if (!filePath || !toPath) return "";
        state.needsClose = true;
        return `\n<dyad-rename from="${escapeXmlAttr(this.relativize(filePath))}" to="${escapeXmlAttr(this.relativize(toPath))}">`;
      }

      case "search": {
        state.needsClose = true;
        return `\n<dyad-grep query="${escapeXmlAttr(title)}">`;
      }

      case "think": {
        state.needsClose = true;
        return `\n<think>`;
      }

      case "fetch": {
        state.needsClose = true;
        return `\n<dyad-web-crawl url="${escapeXmlAttr(title)}">`;
      }

      case "execute":
      default: {
        if (title) {
          return `\n<dyad-status type="info">${escapeXmlContent(title)}</dyad-status>`;
        }
        return "";
      }
    }
  }

  private buildClosingTag(state: ToolCallState): string {
    switch (state.kind ?? "other") {
      case "read":     return "</dyad-read>\n";
      case "edit":     return "\n</dyad-write>\n";
      case "delete":   return "</dyad-delete>\n";
      case "move":     return "</dyad-rename>\n";
      case "search":   return "</dyad-grep>\n";
      case "think":    return "</think>\n";
      case "fetch":    return "</dyad-web-crawl>\n";
      default:         return "";
    }
  }

  private contentItemToXml(item: ToolCallContent): string {
    if (item.type === "diff") {
      return this.diffToSearchReplaceXml(item as Diff & { type: "diff" });
    }
    if (item.type === "content" && item.content.type === "text") {
      return item.content.text;
    }
    return "";
  }

  private diffToSearchReplaceXml(diff: Diff & { type: "diff" }): string {
    const oldText = diff.oldText ?? "";
    const newText = diff.newText ?? "";
    return [
      `\n<dyad-search-replace path="${escapeXmlAttr(this.relativize(diff.path))}">`,
      `<search>${escapeXmlContent(oldText)}</search>`,
      `<replace>${escapeXmlContent(newText)}</replace>`,
      `</dyad-search-replace>\n`,
    ].join("\n");
  }
}

// =============================================================================
// Plan Entries → AgentTodos
// =============================================================================

export function planEntriesToTodos(plan: Plan & { sessionUpdate: "plan" }): AgentTodo[] {
  return plan.entries.map((entry, i) => ({
    id: `acp-plan-${i}`,
    content: entry.content,
    status:
      entry.status === "in_progress"
        ? "in_progress"
        : entry.status === "completed"
          ? "completed"
          : "pending",
  }));
}
