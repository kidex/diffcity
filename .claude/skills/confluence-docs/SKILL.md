---
name: confluence-docs
description: Structure of diffcity's Confluence space DI and the templates for ADRs, phase reports, runbook entries and scope decisions. Use when writing or updating any Confluence page for the project.
---

# Confluence docs

Through the Atlassian MCP. Get the cloudId with `getAccessibleAtlassianResources`. Space key `DI`. Pages are written in English. Use `contentFormat: "markdown"`.

## Before creating a page

Always list the space first (`getPagesInConfluenceSpace` with a `title` filter). Confluence silently appends ` (2)` to a duplicate title, and the MCP cannot delete pages. Update the existing page instead of creating a new one.

## Space structure

```
diffcity Home
├── Overview                 team lead: spec summary, links, phases, verdicts
├── Architecture             architect: components, base rule, ADR template
│   └── ADR-NNN: <decision>  one per decision
├── Agent team and workflow  team lead: team, task flow, guardrails, skills
├── Phase reports            team lead: report template
│   └── Phase N: <name>      one per phase, written at the tag
├── Runbook                  dev-core: install, shell hook, collection, data, troubleshooting
└── Findings format          dev-core: own format and SARIF mapping
```

Updating a page replaces its whole body: read it first, change what you need, write it back complete, with a short `versionMessage`.

## ADR

Child of `Architecture`, title `ADR-NNN: <decision>`, numbered after the highest existing one.

```
Status: proposed | accepted | superseded by ADR-MMM
Date: YYYY-MM-DD
Jira task: DC-N
SPEC.md sections: ...

## Context
## Options
## Decision
## Consequences
```

A deviation from SPEC.md sections 5 or 3a stays `proposed` until the PO approves it. When an ADR changes SPEC.md, update SPEC.md in the same step and comment on the affected epics.

## Phase report

Child of `Phase reports`, title `Phase N: <name>`, following the template on the parent page: tag, epic, period, delivered, left or moved, ADRs, metrics (tests, tasks closed, bugs opened, review findings by severity), lessons.

## Runbook entry

Each command or behaviour gets: what it does, how to run it, where its data lives, the symptoms it can produce and how to check them. Keep the fixed sections: Install, Shell hook, Collection, Claude Code integration, Data, Troubleshooting.

## Scope decision

For a feature moved in or out of v1, a short page under `Architecture` titled `Scope: <feature>`: what, why, which phase, what it displaces. Also update SPEC.md section 2.

## Hygiene

No personal paths, secrets or real project names; use the same invented names as the fixtures.
