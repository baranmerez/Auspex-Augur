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
- Results land in the report's run history, a trend file of aggregates and
  a notification with the title and status; the viewer shows the last
  scheduled result and the trend.
