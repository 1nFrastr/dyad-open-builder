import { describe, it, expect, vi, beforeEach } from "vitest";
import { AcpSessionTranslator, planEntriesToTodos } from "../acp/acp_translator";
import {
  getDyadWriteTags,
  getDyadSearchReplaceTags,
  getDyadRenameTags,
  getDyadDeleteTags,
} from "../ipc/utils/dyad_tag_parser";
import { parseSearchReplaceBlocks } from "../pro/shared/search_replace_parser";
import { escapeSearchReplaceMarkers } from "../pro/shared/search_replace_markers";

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Wrap a raw SessionUpdate object into a minimal SessionNotification */
function n(update: object) {
  return { update } as any;
}

function toolCall(
  toolCallId: string,
  kind: string,
  opts: {
    title?: string;
    locations?: { path: string }[];
    content?: object[];
    status?: string;
  } = {},
) {
  return n({
    sessionUpdate: "tool_call",
    toolCallId,
    kind,
    title: opts.title,
    locations: opts.locations,
    content: opts.content,
    status: opts.status ?? "in_progress",
  });
}

function toolCallUpdate(
  toolCallId: string,
  opts: { content?: object[]; status?: string } = {},
) {
  return n({
    sessionUpdate: "tool_call_update",
    toolCallId,
    content: opts.content,
    status: opts.status,
  });
}

function diffItem(path: string, oldText: string, newText: string) {
  return { type: "diff", path, oldText, newText };
}

function textItem(text: string) {
  return { type: "content", content: { type: "text", text } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("AcpSessionTranslator", () => {
  let t: AcpSessionTranslator;

  beforeEach(() => {
    t = new AcpSessionTranslator();
  });

  // ───── Text & thought ─────────────────────────────────────────────────────

  describe("agent_message_chunk", () => {
    it("emits plain text", () => {
      const chunk = t.translateUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello world" },
      } as any);
      expect(chunk).toBe("Hello world");
      expect(t.getAccumulatedContent()).toBe("Hello world");
    });

    it("ignores non-text content types", () => {
      const chunk = t.translateUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "image" },
      } as any);
      expect(chunk).toBe("");
    });
  });

  describe("agent_thought_chunk", () => {
    it("wraps text in <think> tag", () => {
      const chunk = t.translateUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Thinking..." },
      } as any);
      expect(chunk).toContain("<think>");
      expect(chunk).toContain("Thinking...");
      expect(chunk).toContain("</think>");
    });

    it("XML-escapes content inside <think>", () => {
      t.translateUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "a < b & c > d" },
      } as any);
      const full = t.getAccumulatedContent();
      expect(full).toContain("a &lt; b &amp; c &gt; d");
    });
  });

  // ───── kind: read ─────────────────────────────────────────────────────────

  describe("kind: read", () => {
    it("emits <dyad-read> open tag on tool_call", () => {
      t.translateNotification(toolCall("r1", "read", { locations: [{ path: "src/foo.ts" }] }));
      expect(t.getAccumulatedContent()).toContain('<dyad-read path="src/foo.ts">');
    });

    it("emits </dyad-read> closing tag on completed update", () => {
      t.translateNotification(toolCall("r1", "read", { locations: [{ path: "src/foo.ts" }] }));
      t.translateNotification(toolCallUpdate("r1", { status: "completed" }));
      const full = t.getAccumulatedContent();
      expect(full).toContain("</dyad-read>");
    });

    it("does not embed file content inside the card (content omitted to avoid rendering issues)", () => {
      t.translateNotification(toolCall("r1", "read", { locations: [{ path: "src/foo.ts" }] }));
      t.translateNotification(toolCallUpdate("r1", { content: [textItem("const x = 1;")] }));
      t.translateNotification(toolCallUpdate("r1", { status: "completed" }));
      const full = t.getAccumulatedContent();
      // Card must still open and close
      expect(full).toContain('<dyad-read path="src/foo.ts">');
      expect(full).toContain("</dyad-read>");
      // File content is intentionally dropped from the card body
      const readMatch = full.match(/<dyad-read[^>]*>([\s\S]*?)<\/dyad-read>/);
      expect(readMatch).not.toBeNull();
      expect(readMatch![1].trim()).toBe("");
    });

    it("emits nothing when no path is provided", () => {
      t.translateNotification(toolCall("r1", "read", {}));
      expect(t.getAccumulatedContent().trim()).toBe("");
    });

    it("does not emit a second open tag on repeated update", () => {
      t.translateNotification(toolCall("r1", "read", { locations: [{ path: "src/a.ts" }] }));
      t.translateNotification(toolCallUpdate("r1", { status: "completed" }));
      const full = t.getAccumulatedContent();
      const openCount = (full.match(/<dyad-read/g) ?? []).length;
      expect(openCount).toBe(1);
    });
  });

  // ───── kind: edit — diff path ─────────────────────────────────────────────

  describe("kind: edit with diff", () => {
    it("emits <dyad-search-replace> parseable by getDyadSearchReplaceTags", () => {
      t.translateNotification(toolCall("e1", "edit", { locations: [{ path: "src/foo.ts" }] }));
      t.translateNotification(
        toolCallUpdate("e1", {
          content: [diffItem("src/foo.ts", "old code", "new code")],
          status: "completed",
        }),
      );
      const tags = getDyadSearchReplaceTags(t.getAccumulatedContent());
      expect(tags).toHaveLength(1);
      expect(tags[0].path).toBe("src/foo.ts");
    });

    it("parseSearchReplaceBlocks extracts correct search/replace content", () => {
      t.translateNotification(toolCall("e1", "edit"));
      t.translateNotification(
        toolCallUpdate("e1", {
          content: [diffItem("src/foo.ts", "function old() {}", "function new_() {}")],
          status: "completed",
        }),
      );
      const tags = getDyadSearchReplaceTags(t.getAccumulatedContent());
      const blocks = parseSearchReplaceBlocks(tags[0].content);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].searchContent).toBe("function old() {}");
      expect(blocks[0].replaceContent).toBe("function new_() {}");
    });

    it("handles diff provided in the initial tool_call notification", () => {
      t.translateNotification(
        toolCall("e1", "edit", {
          content: [diffItem("src/foo.ts", "a", "b")],
          status: "completed",
        }),
      );
      const tags = getDyadSearchReplaceTags(t.getAccumulatedContent());
      expect(tags).toHaveLength(1);
      expect(tags[0].path).toBe("src/foo.ts");
      const blocks = parseSearchReplaceBlocks(tags[0].content);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].searchContent).toBe("a");
      expect(blocks[0].replaceContent).toBe("b");
    });

    it("handles multiple diff updates producing multiple <dyad-search-replace> tags", () => {
      t.translateNotification(toolCall("e1", "edit"));
      t.translateNotification(
        toolCallUpdate("e1", { content: [diffItem("src/a.ts", "old_a", "new_a")] }),
      );
      t.translateNotification(
        toolCallUpdate("e1", {
          content: [diffItem("src/b.ts", "old_b", "new_b")],
          status: "completed",
        }),
      );
      const tags = getDyadSearchReplaceTags(t.getAccumulatedContent());
      expect(tags).toHaveLength(2);
      expect(tags[0].path).toBe("src/a.ts");
      expect(tags[1].path).toBe("src/b.ts");
    });

    it("emits <dyad-write> when oldText is null (new file creation)", () => {
      t.translateNotification(toolCall("e1", "edit", { title: "Create Index.tsx" }));
      t.translateNotification(
        toolCallUpdate("e1", {
          content: [{ type: "diff", path: "src/pages/Index.tsx", oldText: null, newText: "export default function Index() {}" }],
          status: "completed",
        }),
      );
      // Should be a write, NOT a search-replace
      const writeTags = getDyadWriteTags(t.getAccumulatedContent());
      const srTags = getDyadSearchReplaceTags(t.getAccumulatedContent());
      expect(writeTags).toHaveLength(1);
      expect(writeTags[0].path).toBe("src/pages/Index.tsx");
      expect(writeTags[0].content).toContain("export default function Index()");
      expect(srTags).toHaveLength(0);
    });

    it("emits <dyad-write> when oldText is undefined (new file creation)", () => {
      t.translateNotification(toolCall("e1", "edit"));
      t.translateNotification(
        toolCallUpdate("e1", {
          content: [{ type: "diff", path: "src/new.ts", newText: "export const x = 1;" }],
          status: "completed",
        }),
      );
      const writeTags = getDyadWriteTags(t.getAccumulatedContent());
      expect(writeTags).toHaveLength(1);
      expect(writeTags[0].path).toBe("src/new.ts");
    });

    it("still emits <dyad-search-replace> when oldText is present (patch)", () => {
      t.translateNotification(toolCall("e1", "edit"));
      t.translateNotification(
        toolCallUpdate("e1", {
          content: [diffItem("src/foo.ts", "old code", "new code")],
          status: "completed",
        }),
      );
      const srTags = getDyadSearchReplaceTags(t.getAccumulatedContent());
      const writeTags = getDyadWriteTags(t.getAccumulatedContent());
      expect(srTags).toHaveLength(1);
      expect(writeTags).toHaveLength(0);
    });

    it("XML-escapes special chars in oldText/newText content", () => {
      t.translateNotification(toolCall("e1", "edit"));
      t.translateNotification(
        toolCallUpdate("e1", {
          content: [diffItem("src/foo.ts", "a < b", "a > b")],
          status: "completed",
        }),
      );
      // After getDyadSearchReplaceTags unescapes, original strings are restored
      const tags = getDyadSearchReplaceTags(t.getAccumulatedContent());
      const blocks = parseSearchReplaceBlocks(tags[0].content);
      expect(blocks[0].searchContent).toBe("a < b");
      expect(blocks[0].replaceContent).toBe("a > b");
    });

    it("diff content containing SEARCH/REPLACE separator lines is parsed correctly", () => {
      // oldText/newText contain lines that look like SEARCH/REPLACE block markers.
      // The translator must escape them so parseSearchReplaceBlocks produces
      // exactly 1 block.  unescapeMarkers() in the processor will restore them
      // before the diff is applied to the file.
      const oldText = "line1\n=======\nline2";
      const newText = "line1\n>>>>>>> REPLACE\nline2";
      t.translateNotification(toolCall("e1", "edit"));
      t.translateNotification(
        toolCallUpdate("e1", {
          content: [diffItem("src/foo.ts", oldText, newText)],
          status: "completed",
        }),
      );
      const tags = getDyadSearchReplaceTags(t.getAccumulatedContent());
      expect(tags).toHaveLength(1);
      const blocks = parseSearchReplaceBlocks(tags[0].content);
      // Exactly 1 block — the separator-like lines did not split the block.
      expect(blocks).toHaveLength(1);
      // The block content contains escaped markers (\======= / \>>>>>>>),
      // matching what escapeSearchReplaceMarkers() produces.
      expect(blocks[0].searchContent).toBe(escapeSearchReplaceMarkers(oldText));
      expect(blocks[0].replaceContent).toBe(escapeSearchReplaceMarkers(newText));
    });
  });

  // ───── kind: edit — full content path ─────────────────────────────────────

  describe("kind: edit with full content", () => {
    it("emits <dyad-write> parseable by getDyadWriteTags on completed", () => {
      t.translateNotification(
        toolCall("e2", "edit", { locations: [{ path: "src/bar.ts" }], title: "Rewrite bar" }),
      );
      t.translateNotification(
        toolCallUpdate("e2", {
          content: [textItem("export const x = 1;")],
          status: "completed",
        }),
      );
      const tags = getDyadWriteTags(t.getAccumulatedContent());
      expect(tags).toHaveLength(1);
      expect(tags[0].path).toBe("src/bar.ts");
      expect(tags[0].content).toBe("export const x = 1;");
    });

    it("buffers content streamed across multiple updates into a single <dyad-write>", () => {
      t.translateNotification(
        toolCall("e2", "edit", { locations: [{ path: "src/bar.ts" }] }),
      );
      t.translateNotification(toolCallUpdate("e2", { content: [textItem("line1\n")] }));
      t.translateNotification(toolCallUpdate("e2", { content: [textItem("line2\n")] }));
      t.translateNotification(toolCallUpdate("e2", { status: "completed" }));
      const tags = getDyadWriteTags(t.getAccumulatedContent());
      expect(tags).toHaveLength(1);
      expect(tags[0].content).toContain("line1");
      expect(tags[0].content).toContain("line2");
    });

    it("emits nothing if completed edit has no content buffer", () => {
      // edit with no content at all, just a completed status — no write tag emitted
      t.translateNotification(
        toolCall("e2", "edit", { locations: [{ path: "src/bar.ts" }], status: "completed" }),
      );
      const tags = getDyadWriteTags(t.getAccumulatedContent());
      expect(tags).toHaveLength(0);
    });

    it("does NOT emit intermediate content to the stream while buffering", () => {
      t.translateNotification(
        toolCall("e2", "edit", { locations: [{ path: "src/bar.ts" }] }),
      );
      const afterOpen = t.getAccumulatedContent();
      t.translateNotification(toolCallUpdate("e2", { content: [textItem("some content")] }));
      // Content should not yet appear (it's buffered)
      expect(t.getAccumulatedContent()).toBe(afterOpen);
    });
  });

  // ───── kind: delete ────────────────────────────────────────────────────────

  describe("kind: delete", () => {
    it("emits <dyad-delete> parseable by getDyadDeleteTags", () => {
      t.translateNotification(
        toolCall("d1", "delete", { locations: [{ path: "src/old.ts" }], status: "completed" }),
      );
      const paths = getDyadDeleteTags(t.getAccumulatedContent());
      expect(paths).toHaveLength(1);
      expect(paths[0]).toBe("src/old.ts");
    });

    it("closes the tag via tool_call_update", () => {
      t.translateNotification(
        toolCall("d1", "delete", { locations: [{ path: "src/old.ts" }] }),
      );
      t.translateNotification(toolCallUpdate("d1", { status: "completed" }));
      const paths = getDyadDeleteTags(t.getAccumulatedContent());
      expect(paths).toHaveLength(1);
    });

    it("emits nothing when no path is provided", () => {
      t.translateNotification(toolCall("d1", "delete", { status: "completed" }));
      expect(t.getAccumulatedContent().trim()).toBe("");
    });
  });

  // ───── kind: move ──────────────────────────────────────────────────────────

  describe("kind: move", () => {
    it("emits <dyad-rename> parseable by getDyadRenameTags", () => {
      t.translateNotification(
        toolCall("m1", "move", {
          locations: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
          status: "completed",
        }),
      );
      const tags = getDyadRenameTags(t.getAccumulatedContent());
      expect(tags).toHaveLength(1);
      expect(tags[0].from).toBe("src/a.ts");
      expect(tags[0].to).toBe("src/b.ts");
    });

    it("falls back to title as destination when only one location is provided", () => {
      t.translateNotification(
        toolCall("m1", "move", {
          locations: [{ path: "src/a.ts" }],
          title: "src/b.ts",
          status: "completed",
        }),
      );
      const tags = getDyadRenameTags(t.getAccumulatedContent());
      expect(tags).toHaveLength(1);
      expect(tags[0].to).toBe("src/b.ts");
    });

    it("emits nothing when from or to path is missing", () => {
      t.translateNotification(toolCall("m1", "move", { status: "completed" }));
      expect(t.getAccumulatedContent().trim()).toBe("");
    });
  });

  // ───── kind: search ────────────────────────────────────────────────────────

  describe("kind: search", () => {
    it("emits <dyad-grep> with query attribute", () => {
      t.translateNotification(
        toolCall("s1", "search", { title: "function foo", status: "completed" }),
      );
      const full = t.getAccumulatedContent();
      expect(full).toContain('<dyad-grep query="function foo">');
      expect(full).toContain("</dyad-grep>");
    });

    it("XML-escapes special chars in the query", () => {
      t.translateNotification(
        toolCall("s1", "search", { title: 'a < "b"', status: "completed" }),
      );
      const full = t.getAccumulatedContent();
      expect(full).toContain("a &lt; &quot;b&quot;");
    });

    it("does not embed search results inside the card (content omitted to avoid rendering issues)", () => {
      t.translateNotification(toolCall("s1", "search", { title: "foo" }));
      t.translateNotification(
        toolCallUpdate("s1", {
          content: [textItem("src/a.ts:10: foo()")],
          status: "completed",
        }),
      );
      const full = t.getAccumulatedContent();
      // Card must still open and close
      expect(full).toContain('<dyad-grep query="foo">');
      expect(full).toContain("</dyad-grep>");
      // Search results are intentionally dropped from the card body
      const grepMatch = full.match(/<dyad-grep[^>]*>([\s\S]*?)<\/dyad-grep>/);
      expect(grepMatch).not.toBeNull();
      expect(grepMatch![1].trim()).toBe("");
    });
  });

  // ───── kind: execute ───────────────────────────────────────────────────────

  describe("kind: execute", () => {
    it("wraps terminal output inside <dyad-status> with title", () => {
      t.translateNotification(toolCall("x1", "execute", { title: "Running tests" }));
      t.translateNotification(
        toolCallUpdate("x1", {
          content: [textItem("all 5 tests passed")],
          status: "completed",
        }),
      );
      const full = t.getAccumulatedContent();
      expect(full).toContain('<dyad-status title="Running tests">');
      expect(full).toContain("all 5 tests passed");
      expect(full).toContain("</dyad-status>");
      // Output must appear BETWEEN the tags, not outside them
      const openIdx = full.indexOf('<dyad-status title="Running tests">');
      const closeIdx = full.indexOf("</dyad-status>");
      const contentIdx = full.indexOf("all 5 tests passed");
      expect(openIdx).toBeLessThan(contentIdx);
      expect(contentIdx).toBeLessThan(closeIdx);
    });

    it("emits status card even without update content", () => {
      t.translateNotification(
        toolCall("x1", "execute", { title: "Running tests", status: "completed" }),
      );
      const full = t.getAccumulatedContent();
      expect(full).toContain('<dyad-status title="Running tests">');
      expect(full).toContain("</dyad-status>");
    });

    it("emits nothing when no title is provided", () => {
      t.translateNotification(toolCall("x1", "execute", { status: "completed" }));
      expect(t.getAccumulatedContent().trim()).toBe("");
    });
  });

  // ───── kind: think ─────────────────────────────────────────────────────────

  describe("kind: think", () => {
    it("emits <think> open tag on tool_call and </think> on completed", () => {
      t.translateNotification(toolCall("th1", "think"));
      t.translateNotification(
        toolCallUpdate("th1", {
          content: [textItem("Analyzing the codebase...")],
          status: "completed",
        }),
      );
      const full = t.getAccumulatedContent();
      expect(full).toContain("<think>");
      expect(full).toContain("Analyzing the codebase...");
      expect(full).toContain("</think>");
    });
  });

  // ───── kind: fetch ─────────────────────────────────────────────────────────

  describe("kind: fetch", () => {
    it("emits <dyad-web-crawl> with url attribute from title", () => {
      t.translateNotification(
        toolCall("f1", "fetch", { title: "https://example.com", status: "completed" }),
      );
      const full = t.getAccumulatedContent();
      expect(full).toContain('<dyad-web-crawl url="https://example.com">');
      expect(full).toContain("</dyad-web-crawl>");
    });
  });

  // ───── system-reminder stripping ──────────────────────────────────────────

  describe("system-reminder stripping", () => {
    it("strips <system-reminder> blocks from agent message chunks", () => {
      t.translateUpdate({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Let me check the file.\n<system-reminder>Do not help with malware.</system-reminder>\nHere is the result.",
        },
      } as any);
      const full = t.getAccumulatedContent();
      expect(full).toContain("Let me check the file.");
      expect(full).toContain("Here is the result.");
      expect(full).not.toContain("<system-reminder>");
      expect(full).not.toContain("Do not help with malware.");
    });

    it("strips <system-reminder> blocks from execute tool call text content", () => {
      // Use execute kind — read/search intentionally drop content, so test via execute
      t.translateNotification(toolCall("e1", "execute", { title: "Run script" }));
      t.translateNotification(
        toolCallUpdate("e1", {
          content: [
            textItem(
              "Script started.\n<system-reminder>Whenever you read a file, consider malware.</system-reminder>\nScript finished.",
            ),
          ],
          status: "completed",
        }),
      );
      const full = t.getAccumulatedContent();
      expect(full).toContain("Script started.");
      expect(full).toContain("Script finished.");
      expect(full).not.toContain("<system-reminder>");
      expect(full).not.toContain("Whenever you read a file");
    });

    it("strips multiline <system-reminder> blocks", () => {
      t.translateUpdate({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Before\n<system-reminder>\nLine one.\nLine two.\n</system-reminder>\nAfter",
        },
      } as any);
      const full = t.getAccumulatedContent();
      expect(full).toContain("Before");
      expect(full).toContain("After");
      expect(full).not.toContain("Line one.");
    });
  });

  // ───── kind: other / unknown ───────────────────────────────────────────────

  describe("kind: other / unknown", () => {
    it("emits <dyad-status> with title for unknown kind", () => {
      t.translateNotification(
        toolCall("u1", "unknown_kind", { title: "Doing something", status: "completed" }),
      );
      expect(t.getAccumulatedContent()).toContain('<dyad-status title="Doing something">');
    });

    it("emits nothing for unknown kind with no title", () => {
      t.translateNotification(toolCall("u1", "unknown_kind", { status: "completed" }));
      expect(t.getAccumulatedContent().trim()).toBe("");
    });
  });

  // ───── plan ────────────────────────────────────────────────────────────────

  describe("plan", () => {
    it("emits <dyad-status> reflecting entry counts", () => {
      t.translateUpdate({
        sessionUpdate: "plan",
        entries: [
          { content: "Task A", status: "completed" },
          { content: "Task B", status: "in_progress" },
          { content: "Task C", status: "pending" },
          { content: "Task D", status: "pending" },
        ],
      } as any);
      const full = t.getAccumulatedContent();
      expect(full).toContain("1 in progress");
      expect(full).toContain("2 pending");
      expect(full).toContain("1 done");
    });

    it("emits nothing when all entries have unknown/empty statuses", () => {
      t.translateUpdate({
        sessionUpdate: "plan",
        entries: [],
      } as any);
      expect(t.getAccumulatedContent().trim()).toBe("");
    });
  });

  // ───── planEntriesToTodos ──────────────────────────────────────────────────

  describe("planEntriesToTodos", () => {
    it("maps in_progress entries", () => {
      const todos = planEntriesToTodos({
        sessionUpdate: "plan",
        entries: [{ content: "Do A", status: "in_progress" }],
      } as any);
      expect(todos[0].status).toBe("in_progress");
      expect(todos[0].content).toBe("Do A");
    });

    it("maps completed entries", () => {
      const todos = planEntriesToTodos({
        sessionUpdate: "plan",
        entries: [{ content: "Done B", status: "completed" }],
      } as any);
      expect(todos[0].status).toBe("completed");
    });

    it("maps pending and other entries as pending", () => {
      const todos = planEntriesToTodos({
        sessionUpdate: "plan",
        entries: [
          { content: "Wait", status: "pending" },
          { content: "Unknown", status: "anything_else" },
        ],
      } as any);
      expect(todos[0].status).toBe("pending");
      expect(todos[1].status).toBe("pending");
    });
  });

  // ───── Path relativization ────────────────────────────────────────────────

  describe("path relativization", () => {
    it("converts absolute paths to relative when workspaceRoot is set", () => {
      const translator = new AcpSessionTranslator("/workspace");
      translator.translateNotification(
        toolCall("r1", "read", {
          locations: [{ path: "/workspace/src/foo.ts" }],
          status: "completed",
        }),
      );
      const full = translator.getAccumulatedContent();
      expect(full).toContain('path="src/foo.ts"');
      expect(full).not.toContain("/workspace/src/foo.ts");
    });

    it("keeps relative paths as-is", () => {
      const translator = new AcpSessionTranslator("/workspace");
      translator.translateNotification(
        toolCall("r1", "read", {
          locations: [{ path: "src/foo.ts" }],
          status: "completed",
        }),
      );
      expect(translator.getAccumulatedContent()).toContain('path="src/foo.ts"');
    });

    it("falls back to basename when path escapes the workspace", () => {
      const translator = new AcpSessionTranslator("/workspace");
      translator.translateNotification(
        toolCall("r1", "read", {
          locations: [{ path: "/other/dir/foo.ts" }],
          status: "completed",
        }),
      );
      // Should use basename, not absolute path
      const full = translator.getAccumulatedContent();
      expect(full).toContain('path="foo.ts"');
      expect(full).not.toContain("/other/dir");
    });

    it("relativizes diff paths in edit operations", () => {
      const translator = new AcpSessionTranslator("/workspace");
      translator.translateNotification(toolCall("e1", "edit"));
      translator.translateNotification(
        toolCallUpdate("e1", {
          content: [diffItem("/workspace/src/foo.ts", "old", "new")],
          status: "completed",
        }),
      );
      const tags = getDyadSearchReplaceTags(translator.getAccumulatedContent());
      expect(tags[0].path).toBe("src/foo.ts");
    });
  });

  // ───── XML escaping in attributes ─────────────────────────────────────────

  describe("XML escaping", () => {
    it("escapes & in file paths for dyad-read attribute", () => {
      t.translateNotification(
        toolCall("r1", "read", {
          locations: [{ path: "src/foo&bar.ts" }],
          status: "completed",
        }),
      );
      expect(t.getAccumulatedContent()).toContain("src/foo&amp;bar.ts");
    });

    it("escapes \" in search query for dyad-grep attribute", () => {
      t.translateNotification(
        toolCall("s1", "search", { title: 'say "hello"', status: "completed" }),
      );
      expect(t.getAccumulatedContent()).toContain("say &quot;hello&quot;");
    });
  });

  // ───── Streaming / incremental rendering ──────────────────────────────────

  describe("streaming incremental rendering", () => {
    it("each translateNotification call returns only the new fragment", () => {
      const frag1 = t.translateNotification(
        toolCall("r1", "read", { locations: [{ path: "src/a.ts" }] }),
      );
      const frag2 = t.translateNotification(toolCallUpdate("r1", { status: "completed" }));
      expect(frag1).toContain("<dyad-read");
      expect(frag1).not.toContain("</dyad-read>");
      expect(frag2).toContain("</dyad-read>");
      expect(frag2).not.toContain("<dyad-read");
    });

    it("accumulated content equals concatenation of all fragments", () => {
      const frags: string[] = [];
      frags.push(t.translateNotification(toolCall("r1", "read", { locations: [{ path: "src/a.ts" }] })));
      frags.push(t.translateNotification(toolCallUpdate("r1", { content: [textItem("content")] })));
      frags.push(t.translateNotification(toolCallUpdate("r1", { status: "completed" })));
      expect(t.getAccumulatedContent()).toBe(frags.join(""));
    });
  });

  // ───── Multiple sequential tool calls ─────────────────────────────────────

  describe("multiple sequential tool calls", () => {
    it("handles read then edit sequence producing both tags", () => {
      // Read
      t.translateNotification(
        toolCall("r1", "read", { locations: [{ path: "src/foo.ts" }] }),
      );
      t.translateNotification(toolCallUpdate("r1", { status: "completed" }));
      // Edit with diff
      t.translateNotification(toolCall("e1", "edit"));
      t.translateNotification(
        toolCallUpdate("e1", {
          content: [diffItem("src/foo.ts", "old", "new")],
          status: "completed",
        }),
      );
      const full = t.getAccumulatedContent();
      // Both tags present
      expect(full).toContain("<dyad-read");
      expect(full).toContain("</dyad-read>");
      expect(full).toContain("<dyad-search-replace");
      expect(full).toContain("</dyad-search-replace>");
      // Parseable
      const writeTags = getDyadWriteTags(full);
      const srTags = getDyadSearchReplaceTags(full);
      expect(writeTags).toHaveLength(0);
      expect(srTags).toHaveLength(1);
    });

    it("handles read then full-file edit sequence", () => {
      t.translateNotification(
        toolCall("r1", "read", { locations: [{ path: "src/foo.ts" }] }),
      );
      t.translateNotification(toolCallUpdate("r1", { status: "completed" }));

      t.translateNotification(
        toolCall("e1", "edit", { locations: [{ path: "src/foo.ts" }] }),
      );
      t.translateNotification(
        toolCallUpdate("e1", {
          content: [textItem("rewritten content")],
          status: "completed",
        }),
      );
      const full = t.getAccumulatedContent();
      const writeTags = getDyadWriteTags(full);
      expect(writeTags).toHaveLength(1);
      expect(writeTags[0].content).toContain("rewritten content");
    });

    it("ignores tool_call_update for unknown toolCallId", () => {
      // Should not throw, just warn
      expect(() =>
        t.translateNotification(toolCallUpdate("nonexistent", { status: "completed" })),
      ).not.toThrow();
      expect(t.getAccumulatedContent()).toBe("");
    });
  });
});
