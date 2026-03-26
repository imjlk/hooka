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
    imageTag: string;
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

const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
  throw new Error("Root app container not found.");
}

root.innerHTML = `
  <main class="shell">
    <section class="hero">
      <div>
        <p class="eyebrow">Hooka / Control Plane</p>
        <h1>Composable automation for WordPress and Cloudflare.</h1>
        <p class="lede">
          Tasks describe work, capabilities describe image contracts, and presets
          keep deployable images simple enough to reason about.
        </p>
      </div>
      <div class="hero-card" id="summary-cards">
        <p class="muted">Loading registry summary…</p>
      </div>
    </section>

    <section class="grid">
      <article class="panel">
        <div class="panel-head">
          <h2>Installed Capabilities</h2>
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
  </main>
`;

void hydrate();

async function hydrate(): Promise<void> {
  const summaryCards = getElement("summary-cards");
  const installedCapabilities = getElement("installed-capabilities");
  const presetList = getElement("preset-list");
  const taskList = getElement("task-list");
  const runList = getElement("run-list");

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
              <p>${preset.imageTag}</p>
            </div>
            <div class="meta">
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
              return `
                <div class="task-row">
                  <div>
                    <strong>${run.taskId}</strong>
                    <p>${run.id}</p>
                    <p>${run.summary ?? run.source}</p>
                  </div>
                  <div class="task-meta">
                    <span class="chip">${run.source}</span>
                    <span class="chip">attempts ${run.attemptCount}</span>
                    <span class="status ${runStatusClass(run.status)}">${run.status}</span>
                  </div>
                </div>
              `;
            })
            .join("")
        : `<p class="muted">No runs have been queued yet.</p>`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summaryCards.innerHTML = `<p class="muted">Failed to load summary: ${message}</p>`;
    installedCapabilities.innerHTML = `<p class="muted">API unavailable.</p>`;
    presetList.innerHTML = `<p class="muted">Preset data unavailable.</p>`;
    taskList.innerHTML = `<p class="muted">Task data unavailable.</p>`;
    runList.innerHTML = `<p class="muted">Run data unavailable.</p>`;
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
