// Claude Code integration (SPEC.md section 7, ADR-037): the `/code-review`
// command file, the Stop hook entry in settings.json and the invocation both
// use. Plain file and JSON code: no parser, no report, no daemon.

export { CLAUDE_CONFIG_DIR_ENV, claudeConfigDir } from './config-dir.js';
export {
  COMMAND_FILE_NAME,
  COMMAND_MARKER,
  FINDINGS_PATH,
  FIX_QUEUE_PATH,
  FIX_QUEUE_TAKING_PATH,
  allowedTools,
  commandFileText,
  isDiffcityCommandFile,
  recordedCli,
  slashCommands,
} from './command-file.js';
export { GLOBAL_CLI, chooseCliInvocation, hookCommand, type ChooseCliOptions, type CliInvocation, type CliInvocationResult } from './hook-command.js';
export { addStopHook, hasStopHook, removeStopHook, stopHookEntry, type SettingsEdit } from './settings.js';
export {
  BACKUP_SUFFIX,
  CLAUDE_CODE_CHECKED_VERSION,
  applyPlan,
  claudeTarget,
  planInstall,
  planRemove,
  writeFileAtomic,
  type ClaudeTarget,
  type FileAction,
  type PlanResult,
  type PlannedFile,
  type SetupPlan,
} from './setup.js';
