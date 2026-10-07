# Findings format

`diffcity import <file>` accepts two formats: diffcity's own JSON and SARIF 2.1. Both end up as the `Finding` records in the change's `Report`, anchored to symbols.

## Own format

A JSON array of findings. `symbolId` is never written by hand: diffcity resolves it on import.

```ts
interface FindingInput {
  id?: string;                 // optional; kept as an alias of the finding key
  source: string;              // who found it: "claude", "semgrep", "eslint", "gitleaks", "human"
  severity: 'high' | 'med' | 'low';
  category: 'security' | 'correctness' | 'scope' | 'style' | 'tests' | 'architecture';
  file: string;                // repo-relative path, forward slashes
  line: number;                // 1-based line in the head (after) version
  title: string;               // one line, at most 4 KiB
  message: string;             // what is wrong and when it breaks, at most 16 KiB
  fix?: string;                // suggested change, at most 4 KiB
  why?: string;                // one-line reading hint for the execution path, at most 4 KiB
  state?: 'open' | 'intended' | 'fixed';   // default "open"
}
```

`why` is a one-line reading hint for the execution path (for example "new route, called without an order"); it is optional and not part of the finding itself. Newlines and runs of whitespace in it are collapsed to single spaces. `category: 'architecture'` is for findings about layering and structure.

Example, as written by the `/code-review` slash command to `.diffcity/findings.json`:

```json
[
  {
    "source": "claude",
    "severity": "high",
    "category": "security",
    "file": "src/auth/order.guard.ts",
    "line": 14,
    "title": "Optional order defaults to allow",
    "message": "When order is undefined the guard returns true. The new cancel route calls it without an order, so any logged-in user can cancel any order.",
    "fix": "Return false when order is undefined, and pass the order from the cancel route."
  },
  {
    "source": "claude",
    "severity": "med",
    "category": "correctness",
    "file": "src/api/orders/orders.controller.ts",
    "line": 42,
    "title": "Missing NotFound handling",
    "message": "svc.cancel throws NotFound; the route has no error mapping, callers get a 500."
  }
]
```

`source` must not start with `rule:`: that prefix belongs to findings computed by diffcity's rules. Such an entry is skipped with the warning `skipped: source "<source>" is reserved for rule findings`.

A file with a missing or malformed field is rejected as a whole, with one message per problem. A file with more than 5,000 findings, or a message over 16 KiB, a title, a fix or a `why` over 4 KiB, is rejected. Sizes are counted in bytes of UTF-8. An entry whose `file` cannot be made repo-relative is skipped with a warning (see Paths).

## Paths

`file` is repo-relative with `/` separators. Backslashes are converted, a leading `./` is dropped. An absolute path (or a `file://` URI) inside the repository root is made relative to it. These are skipped with a warning, the rest of the file is imported:

- `skipped: absolute path "<path>" is outside the repository`
- `skipped: absolute path "<path>" and no repository root`
- `skipped: path "<path>" contains ".."`

## Finding key

Every finding gets the key `f:` followed by the first 16 hex digits of `sha256(source NUL file NUL normalized title NUL line)`. The same finding imported twice has the same key. An own-format `id` is kept as an alias. Findings computed by rules keep `rule:<id>:<hash>` as their id.

## SARIF 2.1

Each entry of `runs[].results[]` becomes one finding.

| SARIF | Finding |
|---|---|
| `runs[].tool.driver.name` | `source` |
| `results[].ruleId` | `title` (`message.text` when `ruleId` is missing) |
| `results[].message.text` | `message` |
| `results[].level` | `severity`: `error` → `high`, `warning` → `med`, `note` / `none` / missing → `low` |
| `results[].locations[0].physicalLocation.artifactLocation.uri` | `file` (made repo-relative) |
| `results[].locations[0].physicalLocation.region.startLine` | `line` |
| `results[].properties.category` | `category` (default `correctness`) |
| `results[].fixes[0].description.text` | `fix` |

Each run's `tool.driver.name` is the `source` of its results (`sarif` when missing). Warnings, with `runs[i].results[j]` as the place unless said otherwise:

- `skipped: source "<source>" is reserved for rule findings`, with `runs[i]` as the place: a run whose tool name starts with `rule:` is skipped as a whole.
- `skipped: no physical location`: no `locations`, an empty `locations: []`, or no `artifactLocation.uri`. A result with no location is never turned into a change-level finding; those come only from rules.
- `skipped: no ruleId and no message text`
- `skipped: absolute path "<path>" is outside the repository`, `skipped: path "<path>" contains ".."`
- `no region.startLine, line 1 used`
- `unknown category "<value>", "correctness" used`

Example, a result from a run of `semgrep`:

```json
{
  "version": "2.1.0",
  "runs": [
    {
      "tool": { "driver": { "name": "semgrep" } },
      "results": [
        {
          "ruleId": "shopfront.no-unchecked-order",
          "level": "error",
          "message": { "text": "The order is used before it is checked." },
          "properties": { "category": "security" },
          "fixes": [{ "description": { "text": "Check the order first." } }],
          "locations": [
            {
              "physicalLocation": {
                "artifactLocation": { "uri": "src/auth/order.guard.ts" },
                "region": { "startLine": 14 }
              }
            }
          ]
        }
      ]
    }
  ]
}
```

## Anchoring

- The finding's line is matched against the symbols of the `after` version of its file; the symbol whose `range` contains the line becomes `symbolId`.
- A line outside every symbol keeps the finding at file level, with no `symbolId`.
- A file that is not part of the change is skipped and counted as `skipped-not-in-change`.
- When several symbols contain the line, the innermost one is used (a method inside its class). A symbol that was deleted never matches: a finding line is a line of the `after` version.
- The finding keeps the symbol's name, kind and first line, and the fingerprint of the symbol (of the file, at file level) at import time.
- On a later head the finding is found again by file, symbol name and kind, and its line moves with the symbol. When the symbol no longer exists, it is anchored by its line, clamped to the last symbol of the file. When the file is no longer in the change, the finding is left out of the Report but kept in the store, and comes back with the file.
- Findings with no file belong to the change and come only from rules. They change no file verdict.

## Deduplication

Findings with the same `symbolId`, the same `category` and the same normalized title (lower case, collapsed whitespace, trailing punctuation removed) merge into one entry. The first source in import order is `source`; every source is listed in `sources`, `source` included. The highest severity wins and the first non-empty `fix` wins. The merged state is `intended` when any part is `intended`; otherwise `open` when any part is `open`; it is `fixed` only when every part is `fixed`. A part one source fixed does not hide a part another source still reports as open.

## States

| State | Meaning | Effect on the verdict |
|---|---|---|
| `open` | default | a high open finding makes the file `risky` |
| `intended` | set by "Mark as intended" | ignored by the verdict |
| `fixed` | set automatically by an import, see below | ignored by the verdict |

### When a finding becomes `fixed`

Only an import fixes findings; a new snapshot never does. On an import, each stored `open` finding of a source the import covers that the import did not report again becomes `fixed` when its file left the change, or when its anchor changed: the symbol's fingerprint (the file's, at file level) differs from the one stored when the finding was imported, or the symbol no longer exists. A finding whose anchor is unchanged stays `open`, as does one whose stored fingerprint is unknown. A finding counts as reported again when the import has the same key, or the same symbol (file at file level), category and normalized title.

The sources an import covers are, in SARIF, the `tool.driver.name` (or `sarif`) of every run that has a `results` array, an empty one included: a tool that now reports nothing fixes its findings whose anchor changed. In the own format they are the sources named by its valid entries.
