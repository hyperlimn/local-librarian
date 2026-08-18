export interface McpToolDescription {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface McpToolResult {
  readonly content: readonly {
    readonly type: "text";
    readonly text: string;
  }[];
  readonly isError?: boolean;
}

export interface McpToolLayer {
  listTools(): Promise<readonly McpToolDescription[]>;
  callTool(name: string, input: unknown): Promise<McpToolResult>;
}

export const PLANNED_MCP_TOOL_NAMES = [
  "roots.propose",
  "roots.approve",
  "roots.list",
  "roots.revoke",
  "inventory.scan_preview",
  "inventory.scan",
  "inventory.summary",
  "inventory.list",
  "inventory.get",
  "inventory.query",
  "organization.plan",
  "organization.review",
  "ingest.plan",
  "ingest.review",
  "ingest.submit",
  "ingest.receipt",
  "jobs.submit",
  "jobs.status",
  "jobs.result",
  "jobs.history",
  "jobs.pause",
  "jobs.resume",
  "jobs.cancel",
  "journal.read",
] as const;

/**
 * The transport-level MCP server stays fail-closed. Safe job application
 * contracts exist separately, but no network/stdio tool registration occurs
 * until authentication and deployment policy are selected.
 */
export class ArchitectureOnlyMcpLayer implements McpToolLayer {
  public listTools(): Promise<readonly McpToolDescription[]> {
    return Promise.resolve([]);
  }

  public callTool(_name: string, _input: unknown): Promise<McpToolResult> {
    return Promise.resolve({
      isError: true,
      content: [
        {
          type: "text",
          text: "The transport-level MCP server is disabled; use only explicitly constructed local application facades.",
        },
      ],
    });
  }
}
