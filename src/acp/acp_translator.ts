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
import { escapeSearchReplaceMarkers } from "../pro/shared/search_replace_markers";

/**
 * Remove agent-internal XML tags that should never surface to the user.
 * Claude Code injects <system-reminder>...</system-reminder> blocks into its
 * responses (e.g. inside read results) as internal safety notes. They are
 * not meaningful to the user and would otherwise appear as raw text.
 */
function stripAgentInternalTags(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, "");
}
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
  /** Primary file path from locations[0], used for buffered <dyad-write> on close */
  filePath?: string;
  status: ToolCallStatus;
  /** Whether the XML tag has been closed */
  closed: boolean;
  /** Whether this tool call emitted a write-style open tag (needs explicit close) */
  needsClose: boolean;
  /** Accumulated full-file content for edit kind (emitted as <dyad-write> at terminal status) */
  editContentBuffer?: string;
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
    return this.append(stripAgentInternalTags(update.content.text));
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
      filePath: update.locations?.[0]?.path,
      status: update.status ?? "pending",
      closed: false,
      needsClose: false,
    };
    this.toolCallStates.set(update.toolCallId, state);

    let xml = this.buildOpeningXml(update, state);

    // If content already comes with the initial tool_call (e.g. diffs)
    if (update.content?.length) {
      for (const item of update.content) {
        xml += this.processContentItem(item, state);
      }
    }

    // If this is a terminal status already
    if (
      update.status === "completed" ||
      update.status === "failed"
    ) {
      state.closed = true;
      xml += this.buildClosingXml(state);
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
        xml += this.processContentItem(item, state);
      }
    }

    const isTerminal =
      update.status === "completed" || update.status === "failed";

    if (isTerminal && !state.closed) {
      state.closed = true;
      xml += this.buildClosingXml(state);
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
    // dyad-status uses the `title` attribute, not inner content text
    const xml = `\n<dyad-status title="${escapeXmlAttr(parts.join(", "))}"></dyad-status>\n`;
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
        // ACP edit diffs are emitted as standalone <dyad-search-replace> tags by
        // processContentItem, so we don't open a wrapper tag here.
        // Full-file content (non-diff) is buffered and emitted as <dyad-write> at close.
        state.needsClose = false;
        return "";
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

      case "execute": {
        // Keep execute output inside the status card so users can expand it.
        if (title) {
          state.needsClose = true;
          return `\n<dyad-status title="${escapeXmlAttr(title)}">`;
        }
        return "";
      }

      default: {
        // Unknown kinds emit a self-closing status chip (no expandable content).
        if (title) {
          return `\n<dyad-status title="${escapeXmlAttr(title)}"></dyad-status>`;
        }
        return "";
      }
    }
  }

  /**
   * Emit the correct closing XML for a tool call.
   *
   * For "edit" kind with buffered full-file content, emits a complete <dyad-write>.
   * For all other kinds with needsClose=true, emits the matching closing tag.
   */
  private buildClosingXml(state: ToolCallState): string {
    // "edit" with buffered full-file text → emit <dyad-write>
    if (state.kind === "edit" && state.editContentBuffer) {
      const relPath = this.relativize(state.filePath ?? "");
      const desc = escapeXmlAttr(state.title ?? "");
      return [
        `\n<dyad-write path="${escapeXmlAttr(relPath)}" description="${desc}">`,
        escapeXmlContent(state.editContentBuffer),
        `</dyad-write>\n`,
      ].join("\n");
    }

    if (!state.needsClose) return "";

    switch (state.kind ?? "other") {
      case "read":    return "</dyad-read>\n";
      case "delete":  return "</dyad-delete>\n";
      case "move":    return "</dyad-rename>\n";
      case "search":  return "</dyad-grep>\n";
      case "think":   return "</think>\n";
      case "fetch":   return "</dyad-web-crawl>\n";
      case "execute": return "</dyad-status>\n";
      default:        return "";
    }
  }

  /**
   * Convert a single tool call content item to its XML fragment.
   *
   * For "edit" kind:
   *  - "diff" items with oldText == null → <dyad-write> (new file creation)
   *  - "diff" items with oldText present → standalone <dyad-search-replace>
   *  - "content" items → buffered into state.editContentBuffer for <dyad-write> at close
   * For all other kinds, text content is emitted inline.
   */
  private processContentItem(item: ToolCallContent, state: ToolCallState): string {
    if (item.type === "diff") {
      const diff = item as Diff & { type: "diff" };
      // ACP protocol: oldText == null means this is a new file (not a patch).
      // Emit <dyad-write> so the UI shows a write card instead of an empty search side.
      if (diff.oldText == null) {
        return this.diffToWriteXml(diff, state.title);
      }
      return this.diffToSearchReplaceXml(diff);
    }
    if (item.type === "content" && item.content.type === "text") {
      const text = item.content.text;
      if (state.kind === "edit") {
        // Buffer full-file content; emitted as <dyad-write> when the tool call closes
        state.editContentBuffer = (state.editContentBuffer ?? "") + text;
        return "";
      }
      // read/search content can be very large and causes rendering issues when
      // placed inside the card (Claude Code often re-emits the same content as
      // agent_message_chunk anyway). Only show the card header (path / query).
      if (state.kind === "read" || state.kind === "search") {
        return "";
      }
      // Strip Claude Code internal tags (e.g. <system-reminder>) that may appear
      // inside execute results but are not meaningful to the user.
      return stripAgentInternalTags(text);
    }
    return "";
  }

  /**
   * Convert a new-file ACP diff (oldText == null) into a <dyad-write> tag.
   * This matches how native Dyad represents file creation.
   */
  private diffToWriteXml(diff: Diff & { type: "diff" }, title?: string): string {
    const relPath = this.relativize(diff.path);
    const desc = escapeXmlAttr(title ?? "");
    return [
      `\n<dyad-write path="${escapeXmlAttr(relPath)}" description="${desc}">`,
      escapeXmlContent(diff.newText),
      `</dyad-write>\n`,
    ].join("\n");
  }

  /**
   * Convert an ACP diff into a standalone <dyad-search-replace> tag using the
   * <<<<<<< SEARCH / ======= / >>>>>>> REPLACE format that DyadSearchReplace expects.
   */
  private diffToSearchReplaceXml(diff: Diff & { type: "diff" }): string {
    // Escape any lines that look like SEARCH/REPLACE block markers so that
    // parseSearchReplaceBlocks does not split on them.  The corresponding
    // unescapeMarkers() call in search_replace_processor will restore them
    // before the diff is applied to the file.
    const oldText = escapeSearchReplaceMarkers(diff.oldText ?? "");
    const newText = escapeSearchReplaceMarkers(diff.newText ?? "");
    return [
      `\n<dyad-search-replace path="${escapeXmlAttr(this.relativize(diff.path))}">`,
      `<<<<<<< SEARCH`,
      escapeXmlContent(oldText),
      `=======`,
      escapeXmlContent(newText),
      `>>>>>>> REPLACE`,
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
