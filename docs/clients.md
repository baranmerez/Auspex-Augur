<p><a href="../README.md">← Back to README</a></p>

# MCP clients, skills and prompts

Registering Auspex with an MCP client, and the bundled skills and prompts.

## 🔌 Register with an MCP client

Auspex is a stdio MCP server. Register it once; databases are managed in the
profiles file, not in the client. Most clients accept this shape:

```json
{
  "mcpServers": {
    "auspex": {
      "command": "node",
      "args": ["/path/to/auspex/src/index.js"]
    }
  }
}
```

Use the server name `auspex` to get tool names like `mcp__auspex__query` in
clients that prefix tools with the server name. Environment variables
(`AUSPEX_HOME`, `AUSPEX_DB_<NAME>`, ...) can go in the client's `env` block.

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add auspex --scope user -- node /path/to/auspex/src/index.js
```

From PowerShell, where `--` is swallowed by the `claude.ps1` shim:

```powershell
claude mcp add-json auspex '{"type":"stdio","command":"node","args":["C:/path/to/auspex/src/index.js"]}' --scope user
```

</details>

<details>
<summary><b>Codex CLI</b></summary>

In `~/.codex/config.toml`:

```toml
[mcp_servers.auspex]
command = "node"
args = ["/path/to/auspex/src/index.js"]
```

</details>

<details>
<summary><b>Cursor</b></summary>

In `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project), use the
`mcpServers` JSON shown above.

</details>

<details>
<summary><b>VS Code</b></summary>

In `.vscode/mcp.json`:

```json
{
  "servers": {
    "auspex": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/auspex/src/index.js"]
    }
  }
}
```

</details>

Other MCP clients work the same way: a stdio server started with
`node src/index.js`.

## 🧩 Skills and prompts

Five workflow guides keep an agent on the cheap and safe path with Auspex.
Each is written once, in [`skills/`](../skills), and reaches the agent in two
ways: as an agent skill (installed files) and as an MCP prompt (served by the
server from the same files at startup).

| Skill | Prompt | Use it for |
|---|---|---|
| [`auspex-explore`](../skills/auspex-explore/SKILL.md) | `explore` | Finding tables, reading structure and relations, fill rates and fan-out, recording findings in the schema memory with few statements |
| [`auspex-report`](../skills/auspex-report/SKILL.md) | `report` | A combined report: one round of at most 3 questions, remembered rules as defaults, status codes from their source (lookup table, enum, check or comment), fan-out/duplicate/NULL checks, and whether cancelled or deleted rows count asked within the 3 questions when no rule is remembered, then save, run and approve in the report library |
| [`auspex-columns`](../skills/auspex-columns/SKILL.md) | `columns` | Scoring column importance 1-5 from the SQL of the report library and the user's script files (roles, reason, sources) next to scores the user states, plus one-line trigger summaries, saved with `score_columns`; no database queries for the scores |
| [`auspex-code`](../skills/auspex-code/SKILL.md) | `code` | Column meanings from the application source code in a configured code root (ORM mapping first, then computations, UI labels, permission flags, validation messages, enum names): one sentence per column saved as an inference with `evidenceCode` references, confirmed only after the user agrees; no database queries |
| [`auspex-ddl`](../skills/auspex-ddl/SKILL.md) | `ddl` | Studying an existing table family (tables, functions, triggers) and designing a similar one: analysis note plus a `BEGIN ... ROLLBACK` script via `save_execute_script`, never executed by Auspex |

Each `SKILL.md` holds the core rules and workflow; longer checklists live in
its `references/` folder and are read only when needed.

**Prompts.** Both arguments are optional: `profile` (the database the user
chose; without it the prompt tells the agent to ask) and `goal` (the request
in the user's words). The prompt text is the skill body followed by its
reference files. Clients that support MCP prompts usually offer them as slash
commands, for example `/mcp__auspex__report`. If a skill file is missing or
malformed, the server stops at startup with `auspex: skills error: ...` and
the file path.

**Install as skills:**

```bash
npm run skills:install                       # into ~/.claude/skills
npm run skills:install -- --target <dir>     # or AUSPEX_SKILLS_TARGET=<dir>
npm run skills:install -- --force            # replace skills you changed there
```

The script prints `installed`, `unchanged` or `replaced` per skill. When an
installed skill differs from the repository copy (line endings aside), it
lists the differing files, writes nothing and exits with code 1; compare the
files, then rerun with `--force` to replace the whole skill folder.
