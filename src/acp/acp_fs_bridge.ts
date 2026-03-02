/**
 * ACP Filesystem Bridge
 *
 * Implements the ACP Client filesystem callbacks (readTextFile / writeTextFile)
 * that the agent calls to access files in the client's workspace.
 *
 * These are passed as DyadClientHandlers to AcpSessionManager and invoked
 * by the SDK's ClientSideConnection when the agent sends fs/* requests.
 */

import fs from "node:fs";
import path from "node:path";
import log from "electron-log";

import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

const logger = log.scope("acp_fs_bridge");

/**
 * Handle fs/read_text_file requests from the agent.
 * Reads the file and returns its content as a string.
 */
export async function handleReadTextFile(
  params: ReadTextFileRequest,
  workspaceRoot: string,
): Promise<ReadTextFileResponse> {
  const fullPath = resolveSafe(workspaceRoot, params.path);
  logger.log(`fs/read_text_file: ${fullPath}`);

  const content = fs.readFileSync(fullPath, "utf-8");

  // Apply optional line/limit slicing
  if (params.line !== undefined || params.limit !== undefined) {
    const lines = content.split("\n");
    const start = (params.line ?? 1) - 1; // line is 1-based
    const end =
      params.limit != null ? start + params.limit : lines.length;
    return { content: lines.slice(start, end).join("\n") };
  }

  return { content };
}

/**
 * Handle fs/write_text_file requests from the agent.
 * Creates directories as needed and writes content to the file.
 */
export async function handleWriteTextFile(
  params: WriteTextFileRequest,
  workspaceRoot: string,
): Promise<WriteTextFileResponse> {
  const fullPath = resolveSafe(workspaceRoot, params.path);
  logger.log(`fs/write_text_file: ${fullPath}`);

  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, params.content, "utf-8");

  return {};
}

/**
 * Resolve a path from the agent safely within workspaceRoot.
 * Throws if the resolved path escapes the workspace (path traversal protection).
 */
function resolveSafe(workspaceRoot: string, agentPath: string): string {
  const resolved = path.isAbsolute(agentPath)
    ? agentPath
    : path.resolve(workspaceRoot, agentPath);

  const normalized = path.normalize(resolved);
  const normalizedRoot = path.normalize(workspaceRoot);

  if (
    !normalized.startsWith(normalizedRoot + path.sep) &&
    normalized !== normalizedRoot
  ) {
    throw new Error(
      `Path traversal blocked: "${agentPath}" resolves outside workspace root`,
    );
  }

  return normalized;
}
