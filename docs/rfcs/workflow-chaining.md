# RFC: Workflow Chaining

Status: Draft

## Summary

Hooka currently models one queued run at a time: a webhook or API request enqueues a task, a capable worker claims it, and the run reaches a terminal state. This is enough for direct deploy or sync work, but common production flows need ordered follow-up work:

- verify an artifact
- deploy it
- run smoke checks
- notify an external system

This RFC proposes a generic workflow chaining model that composes existing tasks and target policies without adding service-specific behavior.

## Goals

- Model multi-step workflows such as `verify -> deploy -> smoke -> notify`.
- Reuse existing task registry entries, target policies, artifact readiness checks, retries, and per-target execution controls.
- Keep each step observable as a normal run with its own status, events, result, and audit trail.
- Preserve idempotency across webhook retries and worker restarts.
- Allow workflows to be triggered by generic webhooks, target-backed webhooks, or API calls.

## Non-Goals

- No visual workflow builder in this phase.
- No custom scripting language.
- No producer-specific workflow semantics.
- No cross-node scheduler assumptions beyond the existing SQLite-backed run store.

## Proposed Model

A workflow is a named template containing ordered steps. Each step references an existing Hooka task or target and defines how its input is derived.

```json
{
  "id": "pages-release",
  "steps": [
    {
      "id": "verify",
      "taskId": "wordpress.export.verify",
      "input": { "exportDir": "{{trigger.input.sourcePath}}" }
    },
    {
      "id": "deploy",
      "targetId": "pages-main",
      "after": ["verify"],
      "overrides": { "branch": "{{trigger.input.branch}}" }
    },
    {
      "id": "smoke",
      "taskId": "http.request",
      "after": ["deploy"],
      "input": { "url": "https://example.com/health" }
    },
    {
      "id": "notify",
      "taskId": "webhook.post",
      "after": ["smoke"]
    }
  ]
}
```

The first implementation should start with linear workflows. The schema can allow `after` arrays from the beginning, but fan-out and join semantics should remain documented-only until the linear path is proven.

## Runtime Concepts

- `workflow`: immutable template loaded from config or registry-like discovery.
- `workflow_run`: one execution of a workflow trigger.
- `workflow_step`: one planned step in a workflow run.
- `run`: existing Hooka run created for a step.

Steps should create normal runs. A workflow runner should enqueue the next step only after its dependencies are terminal and successful, unless the workflow explicitly marks a step as `always` or `onFailure`.

## Idempotency

Workflow triggers need a stable idempotency key. Recommended shape:

```text
workflow:<workflowId>:<sourceEventId>
```

Step runs should derive source event IDs from the workflow run and step ID:

```text
workflow:<workflowRunId>:step:<stepId>
```

This lets Hooka safely retry trigger ingestion or resume workflow planning after a worker/server restart without duplicating step runs.

## Target And Policy Reuse

When a step uses `targetId`, it should resolve through the existing target pipeline:

- merge target defaults with step overrides
- enforce allowed override fields
- enforce target policy preflight checks
- apply artifact readiness checks
- apply target execution controls

This keeps workflow chaining generic and avoids a parallel deploy policy system.

## Failure Semantics

Default behavior:

- A failed step stops downstream steps.
- Retryable failures use the existing run retry/dead-letter behavior.
- A workflow run is `failed` when a required step reaches `failed` or `dead-lettered`.
- A workflow run is `succeeded` when all required steps reach successful terminal states.

Future extensions can add `onFailure` and `always` steps for cleanup or notification.

## Persistence

Minimal tables:

- `workflow_runs`: id, workflow_id, source, source_event_id, status, payload_json, created_at, finished_at
- `workflow_steps`: id, workflow_run_id, step_id, status, run_id, depends_on_json, created_at, finished_at

The existing `runs` table remains the execution record. Workflow tables only track orchestration state.

## API And CLI Surface

Initial API:

- `POST /api/workflows/{id}/runs`
- `GET /api/workflows/runs/{id}`
- `GET /api/workflows/runs/{id}/steps`

Initial CLI:

- `hooka workflow run <workflow-id> --payload-json ...`
- `hooka workflow show <workflow-run-id>`
- `hooka workflow watch <workflow-run-id>`

## Open Questions

- Should workflow templates live in the target config file, a separate workflow file, or registry discovery?
- Should step input templating be limited to JSON pointer references instead of string interpolation?
- Should workflow status be computed from step rows on read, or stored and updated transactionally?
- How much DAG support is needed before the first release?
- Should notify steps be first-class, or just normal tasks from a webhook/http task pack?

## Suggested Implementation Slices

1. Add workflow schemas and config loading.
2. Add workflow run and step persistence.
3. Implement linear step planner/resumer.
4. Add API and CLI read/run/watch surfaces.
5. Add optional failure/notification steps.
