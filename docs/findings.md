# Findings format

`diffcity import <file>` accepts two formats: diffcity's own JSON and SARIF 2.1. Both end up as the `Finding` records in the change's `Report`, anchored to symbols.

## Own format

A JSON array of findings. `symbolId` is never written by hand: diffcity resolves it on import.

```ts
interface FindingInput {
  id?: string;                 // optional; generated when missing
  source: string;              // who found it: "claude", "semgrep", "eslint", "gitleaks", "human"
  severity: 'high' | 'med' | 'low';
  category: 'security' | 'correctness' | 'scope' | 'style' | 'tests';
  file: string;                // repo-relative path, forward slashes
  line: number;                // 1-based line in the head (after) version
  title: string;               // one line
  message: string;             // what is wrong and when it breaks
  fix?: string;                // suggested change
  state?: 'open' | 'intended' | 'fixed';   // default "open"
}
```

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

Results without a physical location are skipped with a warning.

## Anchoring

- The finding's line is matched against the symbols of the `after` version of its file; the symbol whose `range` contains the line becomes `symbolId`.
- A line outside every symbol keeps the finding at file level, with no `symbolId`.
- A file that is not part of the change is reported and skipped.

## Deduplication

Findings with the same `symbolId`, the same `category` and the same normalized title (lower case, collapsed whitespace, trailing punctuation removed) merge into one entry that lists every source.

## States

| State | Meaning | Effect on the verdict |
|---|---|---|
| `open` | default | a high open finding makes the file `risky` |
| `intended` | set by "Mark as intended" | ignored by the verdict |
| `fixed` | set automatically when the symbol changed and a later import no longer reports the finding | ignored by the verdict |
