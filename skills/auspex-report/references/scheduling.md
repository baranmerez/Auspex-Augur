# Scheduled runs

Auspex can run an approved report on a schedule, but it never edits the
schedule file or registers a task for the user. Propose; the user does it.

- **Approved report only.** A draft is not scheduled: finish the approval
  step first. The scheduler always runs the approved SQL, even when a newer
  draft exists.
- **Period:** a built-in preset (`last_7_days`, `yesterday`, `last_month`,
  ...) only for a report saved with `dateRange: true`; otherwise one of the
  report's custom presets (`list_reports` shows both). A catch-up run uses the
  period of its due slot, so propose the preset that matches the cadence
  (weekly: `last_7_days`, daily: `yesterday`).
- **Propose the entry** for `<AUSPEX_HOME or ~/.auspex>/schedules.json` as a
  JSON snippet: `id`, `profile` (the report's db, never a default), `report`
  (db, schema, category, name exactly as `list_reports` shows them), `preset`
  and `cadence` (`{ "weekly": "monday", "at": "08:00" }` or
  `{ "daily": true, "at": "07:30" }`, local time). Ask the user for the day
  and time; do not pick them silently.
- **The user edits the file and registers the task** themselves: tell them
  to run `node src/scheduleCli.js status` to check the entry and
  `node src/scheduleCli.js task-command`, which prints the Task Scheduler
  commands for them to review and run. Never run those commands yourself.
  After a new schedule or a changed time, remind them to run `task-command`
  again and re-register the task. Profiles a schedule uses must be in
  `profiles.json` (or user-level `AUSPEX_DB_*` variables): the task does not
  see settings that exist only in the MCP client configuration.
- Results land in the report's run history, a trend file of aggregates and
  a notification with the title and status; the viewer shows the last
  scheduled result and the trend.

## Inspecting a failed schedule

- For diagnosis, read `status` and supplied local evidence. `run` executes
  a report; `run-due` performs recovery and may execute other due slots. It
  is not a repair-only command. Do not invoke either without authorization
  for those executions.
- Read `status` and `persistence` separately: successful execution can have
  failed trend/state writes and exit 1. A lost trend is not a failed SQL run.
  Notifications use codes; do not paste SQL, parameters or file contents.
- Completed-slot evidence prevents reruns. Recovery uses `pendingTrends`,
  existing trend points or saved runs tagged with schedule ID and slot;
  a manual run or matching timestamp alone is not scheduled evidence.
- A failure recording an older slot holds newer slots for that schedule.
  Read the repair outcome before diagnosing a stuck schedule. Recovery
  continues in slot order when state can be recorded; do not reset
  `lastSuccessSlot`, delete evidence or change schedule IDs to force it.
- `STATE_UNREADABLE` stops execution before SQL. Preserve the state file;
  report the code and request a reviewed recovery decision. Do not silently
  replace it with empty state. Pending points are bounded (50 per schedule);
  `trendLost` / `trendLostSlots` mean missing history, never a zero value.
