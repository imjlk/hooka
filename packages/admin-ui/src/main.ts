type Summary = {
  generatedAt: string;
  counts: {
    tasks: number;
    capabilities: number;
    presets: number;
  };
  installedCapabilities: string[];
  tasks: Array<{
    id: string;
    title: string;
    requires: string[];
    available: boolean;
  }>;
  presets: Array<{
    id: string;
    tier?: "lean" | "combo";
    imageTag: string;
    publicWorkerTag?: string;
    coveredTasks: number;
    capabilities: string[];
  }>;
};

type RunSummary = {
  id: string;
  taskId: string;
  source: string;
  status: string;
  summary: string | null;
  createdAt: string;
  attemptCount: number;
};

type RunDetail = RunSummary & {
  sourceEventId: string | null;
  errorText: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  payload: unknown;
  result: {
    stdout?: string;
    stderr?: string;
    summary?: string;
    status: string;
  } | null;
  capabilitySnapshot: string[];
  workerId: string | null;
  leaseExpiresAt: string | null;
  events: Array<{
    id: string;
    type: string;
    message: string;
    createdAt: string;
    data?: unknown;
  }>;
};

let activeRunId: string | null = null;

const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
  throw new Error("Root app container not found.");
}

root.innerHTML = `
  <main class="shell">
    <section class="hero">
      <div>
        <p class="eyebrow">Hooka / Control Plane</p>
        <h1>Signed webhooks in, queued wrangler work out.</h1>
        <p class="lede">
          Hooka treats producers as simple webhook callers. The worker reads a
          shared source volume, executes the task contract, and keeps the queue
          and run history in SQLite.
        </p>
      </div>
      <div class="hero-card" id="summary-cards">
        <p class="muted">Loading registry summary…</p>
      </div>
    </section>

    <section class="grid">
      <article class="panel">
        <div class="panel-head">
          <h2>Runtime Capabilities</h2>
          <span class="pill">runtime</span>
        </div>
        <div id="installed-capabilities" class="stack"></div>
      </article>

      <article class="panel">
        <div class="panel-head">
          <h2>Preset Catalog</h2>
          <span class="pill">images</span>
        </div>
        <div id="preset-list" class="stack"></div>
      </article>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Task Availability</h2>
        <span class="pill">registry</span>
      </div>
      <div id="task-list" class="stack task-list"></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Recent Runs</h2>
        <span class="pill">queue</span>
      </div>
      <div id="run-list" class="stack task-list"></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Run Detail</h2>
        <span class="pill">inspect</span>
      </div>
      <div id="run-detail" class="detail-panel">
        <p class="muted">Choose a run from the list to inspect its shared-volume payload, output, and events.</p>
      </div>
    </section>
  </main>
`;

document.addEventListener("click", (event) => {
  const target = event.target;

  if (!(target instanceof HTMLElement)) {
    return;
  }

  const trigger = target.closest<HTMLElement>("[data-run-id]");

  if (!trigger) {
    return;
  }

  const runId = trigger.dataset.runId;

  if (!runId) {
    return;
  }

  activeRunId = runId;
  syncSelectedRunButtons();
  void loadRunDetail(runId);
});

void hydrate();

async function hydrate(): Promise<void> {
  const summaryCards = getElement("summary-cards");
  const installedCapabilities = getElement("installed-capabilities");
  const presetList = getElement("preset-list");
  const taskList = getElement("task-list");
  const runList = getElement("run-list");
  const runDetail = getElement("run-detail");

  try {
    const [summaryResponse, runsResponse] = await Promise.all([
      fetch("/api/summary"),
      fetch("/api/runs?limit=8"),
    ]);

    if (!summaryResponse.ok) {
      throw new Error(`Summary API returned ${summaryResponse.status}`);
    }

    if (!runsResponse.ok) {
      throw new Error(`Runs API returned ${runsResponse.status}`);
    }

    const summary = (await summaryResponse.json()) as Summary;
    const runs = (await runsResponse.json()) as RunSummary[];

    summaryCards.innerHTML = [
      metricCard("Tasks", String(summary.counts.tasks)),
      metricCard("Capabilities", String(summary.counts.capabilities)),
      metricCard("Presets", String(summary.counts.presets)),
      metricCard(
        "Generated",
        new Date(summary.generatedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      ),
    ].join("");

    installedCapabilities.innerHTML =
      summary.installedCapabilities.length > 0
        ? summary.installedCapabilities
            .map((capability) => `<span class="chip">${capability}</span>`)
            .join("")
        : `<p class="muted">No capability manifest loaded yet.</p>`;

    presetList.innerHTML = summary.presets
      .map((preset) => {
        return `
          <div class="list-row">
            <div>
              <strong>${preset.id}</strong>
              <p>${preset.publicWorkerTag ?? preset.imageTag}</p>
            </div>
            <div class="meta">
              <span>${preset.tier ?? "preset"}</span>
              <span>${preset.coveredTasks} tasks</span>
              <span>${preset.capabilities.length} caps</span>
            </div>
          </div>
        `;
      })
      .join("");

    taskList.innerHTML = summary.tasks
      .map((task) => {
        const statusClass = task.available ? "available" : "blocked";
        const statusLabel = task.available ? "ready" : "missing";

        return `
          <div class="task-row">
            <div>
              <strong>${task.id}</strong>
              <p>${task.title}</p>
            </div>
            <div class="task-meta">
              <div class="chips">
                ${task.requires
                  .map((requirement) => `<span class="chip">${requirement}</span>`)
                  .join("")}
              </div>
              <span class="status ${statusClass}">${statusLabel}</span>
            </div>
          </div>
        `;
      })
      .join("");

    runList.innerHTML =
      runs.length > 0
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
                    <span class="status ${runStatusClass(run.status)}">${run.status}</span>
                  </div>
                </button>
              `;
            })
            .join("")
        : `<p class="muted">No runs have been queued yet.</p>`;

    if (runs.length === 0) {
      activeRunId = null;
      runDetail.innerHTML =
        `<p class="muted">Choose a run from the list to inspect its payload, output, and events.</p>`;
      return;
    }

    if (!activeRunId || !runs.some((run) => run.id === activeRunId)) {
      activeRunId = runs[0]?.id ?? null;
    }

    if (activeRunId) {
      await loadRunDetail(activeRunId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summaryCards.innerHTML = `<p class="muted">Failed to load summary: ${message}</p>`;
    installedCapabilities.innerHTML = `<p class="muted">API unavailable.</p>`;
    presetList.innerHTML = `<p class="muted">Preset data unavailable.</p>`;
    taskList.innerHTML = `<p class="muted">Task data unavailable.</p>`;
    runList.innerHTML = `<p class="muted">Run data unavailable.</p>`;
    getElement("run-detail").innerHTML =
      `<p class="muted">Run detail unavailable.</p>`;
  }
}

function getElement(id: string): HTMLElement {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing element #${id}`);
  }

  return element;
}

function metricCard(label: string, value: string): string {
  return `
    <div class="metric-card">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `;
}

function runStatusClass(status: string): string {
  if (status === "succeeded") {
    return "available";
  }

  if (status === "queued" || status === "running") {
    return "pending";
  }

  return "blocked";
}

function syncSelectedRunButtons(): void {
  for (const button of document.querySelectorAll<HTMLElement>("[data-run-id]")) {
    button.classList.toggle("selected", button.dataset.runId === activeRunId);
  }
}

async function loadRunDetail(runId: string): Promise<void> {
  const detailNode = getElement("run-detail");

  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`);

    if (!response.ok) {
      throw new Error(`Run detail API returned ${response.status}`);
    }

    const run = (await response.json()) as RunDetail;

    detailNode.innerHTML = `
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
                    .map((capability) => `<span class="chip">${escapeHtml(capability)}</span>`)
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
                  .map((event) => {
                    return `
                      <div class="timeline-item">
                        <div>
                          <strong>${escapeHtml(event.type)}</strong>
                          <p>${escapeHtml(event.message)}</p>
                          <p>${formatTimestamp(event.createdAt)}</p>
                        </div>
                        <pre>${escapeHtml(JSON.stringify(event.data ?? {}, null, 2))}</pre>
                      </div>
                    `;
                  })
                  .join("")
              : `<p class="muted">No events recorded.</p>`
          }
        </div>
      </div>
    `;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    detailNode.innerHTML = `<p class="muted">Failed to load run detail: ${escapeHtml(message)}</p>`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return "Not recorded";
  }

  return new Date(value).toLocaleString();
}
