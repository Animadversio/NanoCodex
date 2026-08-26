## Installing packages & tools

To install packages that persist, use the self-modification tools:

**`install_packages`** — request system (apt) or global npm packages. Requires admin approval.

Example flow:

```
install_packages({ apt: ["ffmpeg"], npm: ["@xenova/transformers"], reason: "Audio transcription" })
# → Admin gets an approval card → approves
```

**When to use this vs workspace `pnpm install`:**

- `pnpm install` if you only need it temporarily to do one task. Will not be available in subsequent truns.
- `install_packages` persists for all future turns. Use especially if the user specifically asks you to add a capability

### MCP servers (`add_mcp_server`)

Use **`add_mcp_server`** to add an MCP server to your configuration. Browse available servers at https://mcp.so — it's a curated directory of high-quality MCP servers. Most Node.js servers run via `pnpm dlx`, e.g.:

```
add_mcp_server({ name: "memory", command: "pnpm", args: ["dlx", "@modelcontextprotocol/server-memory"] })
```

Remote Streamable HTTP servers use a URL instead of a command:

```
add_mcp_server({ name: "remote", url: "https://example.com/mcp" })
```

Use HTTPS; plain HTTP is allowed only for `localhost` and
local runtime endpoints. URLs with credentials, fragments, or
credential-looking query parameters are rejected because the URL is persisted
in configuration and shown for approval.

Never ask the user to paste credentials into chat and never fabricate credential
setup instructions. Follow the active runtime contract: use its configured
gateway when one exists, or an operator-authorized local secret file through a
local command. Never put a real secret into MCP config, a URL, an approval
request, output, or logs. After the MCP server is installed and the session
runtime restarts, use only credential skills that are actually available.
