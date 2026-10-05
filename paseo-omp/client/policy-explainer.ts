export const POLICY_BOUNDARY_COPY = {
  title: "Tool access boundary (fail-closed)",
  body: "Session toolPolicy (exact preapproval grants) is rejected at startup. OMP set_host_tools cannot preserve those grants exactly, and the plugin never broadens them. Use paseoTools to scope which caller-scoped Paseo tools reach OMP as MCP host tools. Use disallowedTools only for known native OMP built-ins: unknown names are rejected, and it never filters MCP tools.",
  docAnchor: "docs/configuration.md#mcp-tools-management-and-policy-boundary",
} as const;
