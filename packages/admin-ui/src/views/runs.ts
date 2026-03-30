import {
  deriveRunFilterOptions,
  selectActiveRunId,
  type RunDetail,
  type RunFilters,
  type RunSummary,
  type Summary,
} from "../helpers";
import { escapeHtml, formatTimestamp, runStatusClass } from "../dom";

export function renderRunList(
  runs: RunSummary[],
  activeRunId: string | null,
): string {
  return runs.length > 0
    ? runs
        .map((run) => {
          const selected = run.id === activeRunId ? " selected" : "";
          return `
            <button type="button" class="task-row run-row${selected}" data-run-id="${run.id}">
              <div>
                <strong>${escapeHtml(run.taskId)}</strong>
                <p>${escapeHtml(run.id)}</p>
                <p>${escapeHtml(run.summary ?? run.source)}</p>
              </div>
              <div class="task-meta">
                <span class="chip">${escapeHtml(run.source)}</span>
                <span class="chip">attempts ${run.attemptCount}</span>
                <span class="status ${runStatusClass(run.status)}">${escapeHtml(run.status)}</span>
              </div>
            </button>
          `;
        })
        .join("")
    : `<p class="muted">No runs matched the current filters.</p>`;
}

export function renderRunDetail(run: RunDetail): string {
  return `
    <div class="detail-grid">
      <div class="detail-card">
        <span class="eyebrow">Run</span>
        <h3>${escapeHtml(run.taskId)}</h3>
        <p>${escapeHtml(run.id)}</p>
        <div class="stack">
          <span class="chip">${escapeHtml(run.source)}</span>
          <span class="status ${runStatusClass(run.status)}">${escapeHtml(run.status)}</span>
          ${run.workerId ? `<span class="chip">${escapeHtml(run.workerId)}</span>` : ""}
        </div>
      </div>
      <div class="detail-card">
        <span class="eyebrow">Timing</span>
        <p>Created: ${formatTimestamp(run.createdAt)}</p>
        <p>Queued: ${formatTimestamp(run.queuedAt)}</p>
        <p>Started: ${formatTimestamp(run.startedAt)}</p>
        <p>Finished: ${formatTimestamp(run.finishedAt)}</p>
      </div>
    </div>
    <div class="detail-grid">
      <div class="detail-card">
        <span class="eyebrow">Summary</span>
        <p>${escapeHtml(run.result?.summary ?? run.summary ?? "No summary recorded.")}</p>
        ${
          run.errorText
            ? `<p class="detail-error">${escapeHtml(run.errorText)}</p>`
            : `<p class="muted">No error text recorded.</p>`
        }
      </div>
      <div class="detail-card">
        <span class="eyebrow">Capabilities</span>
        <div class="stack">
          ${
            run.capabilitySnapshot.length > 0
              ? run.capabilitySnapshot
                  .map(
                    (capability) =>
                      `<span class="chip">${escapeHtml(capability)}</span>`,
                  )
                  .join("")
              : `<p class="muted">No capability snapshot recorded.</p>`
          }
        </div>
      </div>
    </div>
    <div class="detail-grid">
      <div class="detail-card">
        <span class="eyebrow">Payload</span>
        <pre>${escapeHtml(JSON.stringify(run.payload, null, 2))}</pre>
      </div>
      <div class="detail-card">
        <span class="eyebrow">Output</span>
        <p><strong>stdout</strong></p>
        <pre>${escapeHtml(run.result?.stdout ?? "No stdout recorded.")}</pre>
        <p><strong>stderr</strong></p>
        <pre>${escapeHtml(run.result?.stderr ?? "No stderr recorded.")}</pre>
      </div>
    </div>
    <div class="detail-card">
      <span class="eyebrow">Events</span>
      <div class="timeline">
        ${
          run.events.length > 0
            ? run.events
                .map(
                  (event) => `
                    <div class="timeline-item">
                      <div>
                        <strong>${escapeHtml(event.type)}</strong>
                        <p>${escapeHtml(event.message)}</p>
                        <p>${formatTimestamp(event.createdAt)}</p>
                      </div>
                      <pre>${escapeHtml(JSON.stringify(event.data ?? {}, null, 2))}</pre>
                    </div>
                  `,
                )
                .join("")
            : `<p class="muted">No events recorded.</p>`
        }
      </div>
    </div>
  `;
}

export function renderRunDetailPlaceholder(message: string): string {
  return `<p class="muted">${escapeHtml(message)}</p>`;
}

export function renderRunFilterSelectOptions(
  summary: Summary,
  runs: RunSummary[],
  filters: RunFilters,
): {
  selectedRunId: string | null;
  sourceOptionsHtml: string;
  taskOptionsHtml: string;
} {
  const { taskIds, sources } = deriveRunFilterOptions(summary, runs);
  const taskOptions = filters.taskId
    ? [...new Set([...taskIds, filters.taskId])].sort()
    : taskIds;
  const sourceOptions = filters.source
    ? [...new Set([...sources, filters.source])].sort()
    : sources;

  return {
    selectedRunId: selectActiveRunId(runs, null),
    taskOptionsHtml: [
      `<option value="">All</option>`,
      ...taskOptions.map(
        (taskId) =>
          `<option value="${escapeHtml(taskId)}">${escapeHtml(taskId)}</option>`,
      ),
    ].join(""),
    sourceOptionsHtml: [
      `<option value="">All</option>`,
      ...sourceOptions.map(
        (source) =>
          `<option value="${escapeHtml(source)}">${escapeHtml(source)}</option>`,
      ),
    ].join(""),
  };
}
