---
name: jira-flow
description: How diffcity work is tracked in Jira project DC - epics per phase, task and bug format, the To Do / In Progress / Done states and how review and test stages are recorded, branch and commit naming with the task key. Use when creating, moving or commenting on Jira issues, or naming branches and commits.
---

# Jira flow

Through the Atlassian MCP. Get the cloudId with `getAccessibleAtlassianResources`. Project key `DC`. Content is written in English.

## Epics

| Key | Epic |
|---|---|
| DC-1 | Phase 0: Setup |
| DC-2 | Phase 1: Semantic diff |
| DC-3 | Phase 2: Daemon and collection |
| DC-4 | Phase 3: Change screen (3D city) |
| DC-5 | Phase 4: Execution-order reading and findings |
| DC-6 | Phase 5: Audit and export |
| DC-7 | Release |

## Issue types

`Epic`, `Task` (default for work), `Bug` (opened by the tester), `Story` and `Subtask` (unused). Every Task and Bug has the phase epic as parent.

## Task format

- **Summary:** imperative, one line, e.g. `Symbol status: detect sig`.
- **Description:**
  - context in two or three lines;
  - `Spec: SPEC.md §5.1` (the section it implements);
  - `Acceptance criteria:` as a bullet list, copied from the phase's definition of done or the spec rule, each one testable;
  - `Agent: dev-core` or `dev-ui`.
- Tasks for a phase are created by the team lead after the architect's plan and the PO's OK.

## Bug format

Summary with the symptom; description with steps, expected, actual, failing test, commit, artefacts. Parent: the phase epic. Linked to the task with type `Relates`.

## States

The workflow has three states. Transition ids: `11` To Do, `21` In Progress, `31` Done.

| Moment | State | Comment on the issue |
|---|---|---|
| Dispatched to a dev agent | In Progress | `Started: <agent>, branch DC-<nr>-<slug>` |
| Reviewer verdict | In Progress | `Review: approved` or `Review: rework` + findings |
| Tester verdict | In Progress | `Test: passed (N tests)` or `Test: failed, see DC-<bug>` |
| Merged by the team lead | Done | summary: what changed, commits, tests, anything left out |

A task goes to Done only after `Review: approved` and `Test: passed`, and, when it has visible behaviour, with its proof video attached (or its path in a comment while the upload is pending; see the testing skill). An epic is closed at the phase tag, after the phase report exists in Confluence.

## Git naming

- Branch and worktree: `DC-<nr>-<slug>` (slug in English, kebab-case), in `.worktrees/DC-<nr>-<slug>`.
- Commits: conventional with the key, `feat(DC-<nr>): ...`, `fix(DC-<nr>): ...`, `test(DC-<nr>): ...`, `chore(DC-<nr>): ...`. Commit messages are in English.
- Tags: `v0.<phase>.0` at the end of each phase.
