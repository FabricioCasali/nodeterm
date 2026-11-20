// PAR-255: the core planner (what a Windows-native session-host pane is launched with) places the
// per-session `--launch-args` exactly where the typed line does, and re-validates them.
import { describe, expect, it } from "vitest";
import type { AgentLaunchIntent } from "../shared/types";
import { LAUNCH_ARGS_MAX_TOKENS } from "../shared/agents/launch-args";
import {
  AgentLaunchPreparationError,
  prepareAgentLaunch,
  type AgentLaunchTrustedContext,
} from "./agent-launch";

const start = (
  agentId: string,
  extra: Partial<Extract<AgentLaunchIntent, { action: "start" }>> = {},
): AgentLaunchIntent => ({ kind: "agent", action: "start", agentId, ...extra });

const ctx = (
  agentId: string,
  extra: Partial<AgentLaunchTrustedContext> = {},
): AgentLaunchTrustedContext => ({
  expectedAgentId: agentId,
  sharedIdentityAvailable: false,
  ...extra,
});

const nativeResolver = (exe: string): AgentLaunchTrustedContext["resolveExecutableKind"] =>
  async () => ({ kind: "native", executable: exe });

async function refusal(intent: AgentLaunchIntent, context: AgentLaunchTrustedContext) {
  try {
    await prepareAgentLaunch(intent, "posix", context);
  } catch (error) {
    expect(error).toBeInstanceOf(AgentLaunchPreparationError);
    return (error as AgentLaunchPreparationError).code;
  }
  throw new Error("expected a refusal");
}

describe("prepareAgentLaunch launchArgs", () => {
  it("claude: after the prompt and the mode/session/model flags", async () => {
    await expect(
      prepareAgentLaunch(
        start("claude", {
          prompt: "go",
          permissionMode: "plan",
          model: "opus",
          launchArgs: ["--strict-mcp-config", "--mcp-config", "C:/x/mcp.json"],
        }),
        "posix",
        ctx("claude"),
      ),
    ).resolves.toEqual({
      command:
        "'claude' 'go' '--permission-mode' 'plan' '--model' 'opus' '--strict-mcp-config' '--mcp-config' 'C:/x/mcp.json'",
    });
  });

  it("grok: before the `--` separator", async () => {
    await expect(
      prepareAgentLaunch(
        start("grok", { prompt: "hi", launchArgs: ["--verbose"] }),
        "posix",
        ctx("grok"),
      ),
    ).resolves.toEqual({ command: "'grok' '--verbose' '--' 'hi'" });
  });

  it("a launch with launch args and no prompt", async () => {
    await expect(
      prepareAgentLaunch(
        start("codex", { launchArgs: ["-c", "mcp_servers.linear.enabled=false"] }),
        "posix",
        ctx("codex"),
      ),
    ).resolves.toEqual({
      command: "'codex' '-c' 'mcp_servers.linear.enabled=false'",
    });
  });

  it("a custom agent: after its own args", async () => {
    await expect(
      prepareAgentLaunch(
        start("claude-orq", { prompt: "go", launchArgs: ["--mcp-config", "C:/x/m.json"] }),
        "posix",
        ctx("claude-orq", {
          customAgent: {
            id: "claude-orq",
            launchCmd: "claude",
            baseAgent: "claude",
            args: "--add-dir /w",
          },
        }),
      ),
    ).resolves.toEqual({
      command: "'claude' '--add-dir' '/w' 'go' '--mcp-config' 'C:/x/m.json'",
    });
  });

  it("pwsh native: each element CRT-quoted inside one argument line", async () => {
    const plan = await prepareAgentLaunch(
      start("codex", {
        prompt: "go",
        launchArgs: ["-c", 'skills.config=[{name="a:b",enabled=false}]'],
      }),
      "pwsh",
      ctx("codex", { resolveExecutableKind: nativeResolver("C:\\Tools\\codex.exe") }),
    );
    expect(plan.command).toBe(
      "$ntAgent = Start-Process -FilePath 'C:\\Tools\\codex.exe' -ArgumentList " +
        `'go -c "skills.config=[{name=\\"a:b\\",enabled=false}]"' -NoNewWindow -Wait -PassThru ; $global:LASTEXITCODE = $ntAgent.ExitCode`,
    );
  });

  it("pwsh script entry point: each element PowerShell-quoted", async () => {
    const plan = await prepareAgentLaunch(
      start("claude", { launchArgs: ["--mcp-config", "C:/my dir/it's.json"] }),
      "pwsh",
      ctx("claude", {
        resolveExecutableKind: async () => ({
          kind: "powershell-script",
          executable: "C:\\npm\\claude.ps1",
        }),
      }),
    );
    expect(plan.command).toBe("& 'C:\\npm\\claude.ps1' '--mcp-config' 'C:/my dir/it''s.json'");
  });

  it("refuses a malformed launchArgs field", async () => {
    expect(await refusal(start("claude", { launchArgs: ["ok", "bad\nline"] }), ctx("claude"))).toBe(
      "invalid-intent",
    );
    expect(
      await refusal(start("claude", { launchArgs: "--x" as unknown as string[] }), ctx("claude")),
    ).toBe("invalid-intent");
    expect(
      await refusal(
        start("claude", { launchArgs: Array.from({ length: LAUNCH_ARGS_MAX_TOKENS + 1 }, () => "-v") }),
        ctx("claude"),
      ),
    ).toBe("invalid-intent");
    expect(
      await refusal(start("claude", { launchArgs: [42 as unknown as string] }), ctx("claude")),
    ).toBe("invalid-intent");
  });

  it("a launch arg counts for the codex `--remote` no-daemon rule, like on the typed line", async () => {
    await expect(
      prepareAgentLaunch(
        start("codex", { launchArgs: ["--remote", "ws://h"] }),
        "posix",
        ctx("codex", { codexNoDaemon: true }),
      ),
    ).resolves.toEqual({ command: "'codex' '--remote' 'ws://h'" });
    await expect(
      prepareAgentLaunch(start("codex", { launchArgs: ["-v"] }), "posix", ctx("codex", { codexNoDaemon: true })),
    ).resolves.toEqual({ command: "'codex' '--no-daemon' '-v'" });
  });
});
