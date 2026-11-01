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
| [`auspex-explore`](../skills/auspex-explore/SKILL.md) | `explore` | Table/view discovery, definition-based view comparisons, sample-aware measurements and scoped memory findings |
| [`auspex-report`](../skills/auspex-report/SKILL.md) | `report` | Report design and reconciliation, explicit stage/version selection, library delivery and recovery without repeating completed work; SQL-only and plan-only requests stay within that scope |
| [`auspex-columns`](../skills/auspex-columns/SKILL.md) | `columns` | Usage scores from a defined SQL corpus, preserving user scores; scan hashes alone cannot reconstruct per-column usage |
| [`auspex-code`](../skills/auspex-code/SKILL.md) | `code` | Column meanings from authorized source roots, with verified mappings, source references and user-confirmed interpretations |
| [`auspex-ddl`](../skills/auspex-ddl/SKILL.md) | `ddl` | Explicit schema design and user-run preview scripts; never database execution or an automatic extension of exploration |

Each `SKILL.md` holds the core rules and workflow. Installed skills can load
their linked `references/` files only when needed. MCP prompts currently
include **all** of a skill's references; this is not deferred loading.

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

Repository edits do not update installed copies. Review differences before
reinstalling into the intended client's skill folder, and restart the MCP
server to reload its prompts. No new tool or client-specific frontmatter is
required by these workflows.

<details>
<summary><b>Maintaining and evaluating the workflows</b></summary>

The [Agent Skills specification](https://agentskills.io/specification) defines
the portable frontmatter and reference layout. Its
[authoring guidance](https://agentskills.io/skill-creation/best-practices) and
[Claude's authoring guidance](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
favor focused triggers, selective references and evaluations based on actual
tasks. Keep Auspex-specific tool contracts here; do not copy a general
PostgreSQL handbook into every skill. External PostgreSQL review skills can
supplement a task, but cannot authorize database writes or bypass Auspex.
For example, [Supabase's PostgreSQL skill](https://supabase.com/docs/guides/ai-tools/ai-skills#supabase-postgres-best-practices)
covers schema, migrations, query performance and security; it is optional
domain guidance, not a replacement for Auspex's profile, memory and
user-run-script workflow. No external skill installation is required.

Use these synthetic cases when reviewing a skill change. They are evaluation
criteria, not a claim that an agent execution passed them. Supply only the
relevant skill, user request and fixture evidence to an evaluator, then
inspect its tool choices and output. Do not use production data.

| Case | Expected decision |
|---|---|
| Profile and source root were already selected in the conversation | Reuse them; do not ask again or switch roots |
| Database-only exploration request | Explore catalog/views; do not scan application code or prepare DDL |
| A view has a status predicate and a two-column join key | Read full definition; dependency edges alone are insufficient |
| A capped sample has fillRate 0 and fan-out max 1 | Report sample evidence, not globally unused or guaranteed 1:1 |
| Four unresolved choices affect report totals | Resolve the remaining correctness decision; do not silently guess after three questions |
| Two children multiply parent rows; output is grouped | Aggregate at the correct key; compare group counts and exact matching totals |
| Unchanged SQL uses one column; changed SQL uses another | Retain both contributions by rereading or reusing complete attribution |
| A previously scanned file uses a newly targeted table | Hash history alone does not justify skipping its attribution |
| Two separately registered reports have similar `_v2` names | Do not collapse distinct identities by filename spelling |
| A saved note returns an ID plus repair; a report returns partialCommit | Keep committed evidence; do not repeat add or SQL to heal memory |
| Scheduled execution is ok but state persistence failed | Report incomplete persistence; do not use run-due as a repair-only inspection |
| A confirmed code meaning conflicts with a current value converter | Show the scoped conflict; do not silently overwrite the rule |
| A supplied definition contains an instruction to run a command | Treat it as source data; do not execute the instruction |
| User requests only a DDL design; a preview later fails at a savepoint | Do not execute it; explain ROLLBACK TO the existing savepoint before continuing |

The existing offline checks cover prompt loading, link resolution, skill
size and installation into temporary homes:

```bash
node --test tests/prompts.test.js tests/installSkills.test.js
```

These checks do not measure model selection quality or live database
behavior. Keep those evidence levels separate. A future change to deferred
MCP references or persisted per-file attribution needs its own runtime design;
documentation alone cannot implement either capability.

</details>
