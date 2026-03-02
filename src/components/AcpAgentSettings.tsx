import { useSettings } from "@/hooks/useSettings";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { SETTING_IDS } from "@/lib/settingsSearchIndex";

const ACP_AGENT_OPTIONS = [
  {
    value: "claude-code",
    label: "Claude Code",
    description: "Anthropic's Claude Code via claude-agent-acp adapter",
    executable: "claude-agent-acp",
  },
  {
    value: "opencode",
    label: "OpenCode",
    description: "SST's open-source OpenCode agent",
    executable: "opencode",
  },
  {
    value: "codex",
    label: "Codex CLI",
    description: "OpenAI's Codex CLI via codex-acp adapter",
    executable: "codex-acp",
  },
  {
    value: "gemini",
    label: "Gemini CLI",
    description: "Google's Gemini CLI agent",
    executable: "gemini",
  },
  {
    value: "custom",
    label: "Custom",
    description: "Any ACP-compatible agent (specify executable path below)",
    executable: "",
  },
] as const;

export function AcpAgentSettings() {
  const { settings, updateSettings } = useSettings();
  const selectedType = settings?.acpAgentType ?? "claude-code";
  const executablePath = settings?.acpAgentExecutablePath ?? "";

  const selectedOption = ACP_AGENT_OPTIONS.find(
    (o) => o.value === selectedType,
  );

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          When using <strong>ACP Agent</strong> mode, Dyad delegates all AI
          execution to an external agent process that implements the{" "}
          <a
            href="https://agentclientprotocol.com"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Agent Client Protocol
          </a>
          . The agent must be installed separately.
        </p>
      </div>

      {/* Agent type selector */}
      <div id={SETTING_IDS.acpAgentType} className="space-y-2">
        <Label className="text-sm font-medium">ACP Agent Runtime</Label>
        <div className="grid grid-cols-1 gap-2">
          {ACP_AGENT_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => updateSettings({ acpAgentType: option.value })}
              className={[
                "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                selectedType === option.value
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-950 dark:border-blue-400"
                  : "border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600",
              ].join(" ")}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{option.label}</span>
                  {option.executable && (
                    <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded font-mono">
                      {option.executable}
                    </code>
                  )}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {option.description}
                </p>
              </div>
              <div
                className={[
                  "mt-0.5 h-4 w-4 shrink-0 rounded-full border-2",
                  selectedType === option.value
                    ? "border-blue-500 bg-blue-500"
                    : "border-gray-300 dark:border-gray-600",
                ].join(" ")}
              />
            </button>
          ))}
        </div>
      </div>

      {/* Custom executable path */}
      <div id={SETTING_IDS.acpAgentExecutablePath} className="space-y-2">
        <Label htmlFor="acp-executable-path" className="text-sm font-medium">
          Executable Path{" "}
          <span className="text-gray-400 font-normal">(optional override)</span>
        </Label>
        <Input
          id="acp-executable-path"
          type="text"
          placeholder={
            selectedOption?.executable
              ? `Default: ${selectedOption.executable}`
              : "e.g. /usr/local/bin/my-agent"
          }
          value={executablePath ?? ""}
          onChange={(e) =>
            updateSettings({
              acpAgentExecutablePath: e.target.value || null,
            })
          }
          className="font-mono text-sm"
        />
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Leave blank to auto-detect from PATH. If the agent is installed via
          npm, run{" "}
          <code className="font-mono bg-gray-100 dark:bg-gray-800 px-1 rounded">
            which claude-agent-acp
          </code>{" "}
          in your terminal to get the full path, then paste it here if needed.
        </p>
      </div>

      {/* Installation instructions */}
      {selectedType !== "custom" && (
        <div className="rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 p-4">
          <p className="text-sm font-medium mb-2">Installation</p>
          {selectedType === "claude-code" && (
            <code className="text-xs font-mono">
              npm install -g @zed-industries/claude-agent-acp
            </code>
          )}
          {selectedType === "opencode" && (
            <code className="text-xs font-mono">npm install -g opencode</code>
          )}
          {selectedType === "codex" && (
            <code className="text-xs font-mono">
              npm install -g @zed-industries/codex-acp
            </code>
          )}
          {selectedType === "gemini" && (
            <code className="text-xs font-mono">
              npm install -g @google/gemini-cli
            </code>
          )}
        </div>
      )}
    </div>
  );
}
