// The `/diffcity-review` slash command file, `commands/diffcity-review.md`
// (SPEC.md section 7.1, ADR-037). It is not called `/code-review`, so it never
// shadows Claude Code's bundled `code-review` skill, and
// `disable-model-invocation: true` lets only the user start it (ADR-001: the
// browser opens only when the user asked). Claude Code wants the YAML frontmatter at the top of
// the file, so the version marker is the line right after the frontmatter's
// closing `---`: a file is diffcity's when that line is exactly the marker.
// setup-claude overwrites or removes only such a file.
//
// `<cli>` in the text is the invocation of the Stop hook command, so the
// `Bash(<cli> diff:*)` and `Bash(<cli> import:*)` entries of `allowed-tools`
// are prefixes of the exact commands the body asks for. The fix-queue steps
// are allowed one exact command each.

/** The version marker; v1 is the only version so far. */
export const COMMAND_MARKER = '<!-- diffcity: diffcity-review v1 -->';

/** The file name under `commands/`; Claude Code names the command after it. */
export const COMMAND_FILE_NAME = 'diffcity-review.md';

/**
 * The file and marker of the command's first name, before it was renamed.
 * `--remove` deletes a leftover file only when it carries this marker.
 */
export const LEGACY_COMMAND_FILE_NAME = 'code-review.md';
export const LEGACY_COMMAND_MARKER = '<!-- diffcity: code-review v1 -->';

/**
 * The fix queue directory (one file per item), and the name the command
 * renames it to before applying it (ADR-036, ADR-037, DC-112).
 */
export const FIX_QUEUE_PATH = '.diffcity/fix-queue';
export const FIX_QUEUE_TAKING_PATH = '.diffcity/fix-queue.taking';
export const FINDINGS_PATH = '.diffcity/findings.json';

/** The commands the body runs, for an invocation `cli`. */
export function slashCommands(cli: string): { diff: string; import: string; take: string; drop: string } {
  return {
    diff: `${cli} diff --json --compact`,
    import: `${cli} import ${FINDINGS_PATH} --open`,
    take: `mv ${FIX_QUEUE_PATH} ${FIX_QUEUE_TAKING_PATH}`,
    drop: `rm -r ${FIX_QUEUE_TAKING_PATH}`,
  };
}

/**
 * The `allowed-tools` entries: exactly what the body needs, nothing more.
 * Written as a YAML list, one entry per item, which Claude Code 2.1.288 reads
 * as it reads a comma-separated string, without splitting one rule from the
 * next. The two fix-queue commands are exact rules; `Glob` lists the taken
 * item files and `Read` reads them (and the diff output, when it is long).
 */
export function allowedTools(cli: string): string[] {
  const { take, drop } = slashCommands(cli);
  return [`Bash(${cli} diff:*)`, `Bash(${cli} import:*)`, `Bash(${take})`, `Bash(${drop})`, 'Read', 'Glob', `Write(${FINDINGS_PATH})`];
}

/** The full file for an invocation `cli`. */
export function commandFileText(cli: string): string {
  const run = slashCommands(cli);
  return [
    '---',
    'description: Review the current change with diffcity and put the findings on the city',
    'argument-hint: [what the task was]',
    'disable-model-invocation: true',
    'allowed-tools:',
    ...allowedTools(cli).map((entry) => `  - ${entry}`),
    '---',
    COMMAND_MARKER,
    'All paths below are relative to the repository root: run every command from there.',
    `First take the fixes queued from diffcity. If \`${FIX_QUEUE_TAKING_PATH}\` exists, an earlier run`,
    'stopped halfway: apply it and remove it as below before anything else.',
    `Run \`${run.take}\`; when \`${FIX_QUEUE_PATH}\` does not exist, nothing is queued.`,
    `Otherwise find every \`${FIX_QUEUE_TAKING_PATH}/**/*.json\` with Glob and read each one: a file is one item.`,
    'An item with `file`, `line`, `title`, `message` and `fix` is a finding to fix; an item with',
    '`kind: "review-summary"` is the reviewer\'s summary, in `message`. Apply every item.',
    `Then run \`${run.drop}\`.`,
    '',
    `Run \`${run.diff}\` and read the result: it is the semantic diff of the current change`,
    '(touched files and symbols, changed signatures with call sites, the execution path, tier 1 zones).',
    'Review this change with a focus on: security (auth/authz, input validation, secrets),',
    'correctness (unhandled errors, edge cases, money arithmetic), scope creep relative to $ARGUMENTS,',
    'tests that actually assert something, architecture violations.',
    `Write the findings to \`${FINDINGS_PATH}\` as a JSON array, one object per finding, with`,
    '`source: "claude"`, `file`, `line`, `severity` (`high`, `med` or `low`), `category` (`security`,',
    '`correctness`, `scope`, `style`, `tests` or `architecture`), `title` (one line), `message` (what is',
    'wrong and when it breaks) and `fix` (the change to make). `file` is the repo-relative path of a file',
    'in the diff and `line` a line of its current version: never invent a file or a line.',
    'Set `why`, a one-line hint on why the code is there, only on a `scope` finding.',
    'Write `[]` when you find nothing.',
    `Then run \`${run.import}\`.`,
    '',
  ].join('\n');
}

/**
 * True when `text` is a command file diffcity wrote: a frontmatter opened by
 * `---` on the first line, closed by the next `---` line, and `marker` on
 * the line right after it.
 */
export function isDiffcityCommandFile(text: string, marker: string = COMMAND_MARKER): boolean {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return false;
  const close = lines.indexOf('---', 1);
  return close > 0 && lines[close + 1] === marker;
}

/**
 * The invocation recorded in a diffcity command file (from its
 * `Bash(<cli> diff:*)` entry), or null. setup uses it to find the hook an
 * earlier setup wrote with another invocation. Reads the list form and the
 * comma-separated form the first files had.
 */
export function recordedCli(text: string, marker: string = COMMAND_MARKER): string | null {
  if (!isDiffcityCommandFile(text, marker)) return null;
  for (const line of text.split(/\r?\n/)) {
    const match = /^ {2}- Bash\((.+) diff:\*\)$/.exec(line) ?? /^allowed-tools: Bash\((.+?) diff:\*\),/.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}
