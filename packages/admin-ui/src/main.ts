import type {
  Capability,
  PresetWithPlan,
  RunDetail,
  RunFilters,
  RunSummary,
  Summary,
} from "./helpers";
import { buildRunQuery, selectActiveRunId } from "./helpers";
import { escapeHtml, getElement, syncSelectedRows } from "./dom";
import { renderShell } from "./shell";
import {
  renderCapabilityEnv,
  renderInstalledCapabilities,
  renderSummaryCards,
  renderTaskAvailability,
} from "./views/summary";
import {
  renderPresetDetail,
  renderPresetList,
} from "./views/presets";
import {
  renderRunDetail,
  renderRunDetailPlaceholder,
  renderRunFilterSelectOptions,
  renderRunList,
} from "./views/runs";

const state: {
  activePresetId: string | null;
  activeRunId: string | null;
  capabilities: Capability[];
  filters: RunFilters;
  presets: PresetWithPlan[];
  runs: RunSummary[];
  summary: Summary | null;
} = {
  activePresetId: null,
  activeRunId: null,
  capabilities: [],
  filters: {
    limit: 8,
  },
  presets: [],
  runs: [],
  summary: null,
};

const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
  throw new Error("Root app container not found.");
}

root.innerHTML = renderShell();

document.addEventListener("click", (event) => {
  const target = event.target;

  if (!(target instanceof HTMLElement)) {
    return;
  }

  const runTrigger = target.closest<HTMLElement>("[data-run-id]");

  if (runTrigger?.dataset.runId) {
    state.activeRunId = runTrigger.dataset.runId;
    syncSelectedRows("[data-run-id]", state.activeRunId);
    void loadRunDetail(state.activeRunId);
    return;
  }

  const presetTrigger = target.closest<HTMLElement>("[data-preset-id]");

  if (presetTrigger?.dataset.presetId) {
    state.activePresetId = presetTrigger.dataset.presetId;
    syncSelectedRows("[data-preset-id]", state.activePresetId);
    renderPresetPanels();
    return;
  }

  if (target.id === "run-refresh") {
    void hydrate();
  }
});

document.addEventListener("change", (event) => {
  const target = event.target;

  if (!(target instanceof HTMLSelectElement)) {
    return;
  }

  if (target.id === "run-filter-status") {
    state.filters.status = target.value || undefined;
    void loadRuns();
  }

  if (target.id === "run-filter-task") {
    state.filters.taskId = target.value || undefined;
    void loadRuns();
  }

  if (target.id === "run-filter-source") {
    state.filters.source = target.value || undefined;
    void loadRuns();
  }
});

void hydrate();

async function hydrate(): Promise<void> {
  try {
    const [summaryResponse, presetsResponse, capabilitiesResponse] =
      await Promise.all([
        fetch("/api/summary"),
        fetch("/api/presets"),
        fetch("/api/capabilities"),
      ]);

    if (!summaryResponse.ok) {
      throw new Error(`Summary API returned ${summaryResponse.status}`);
    }

    if (!presetsResponse.ok) {
      throw new Error(`Presets API returned ${presetsResponse.status}`);
    }

    if (!capabilitiesResponse.ok) {
      throw new Error(`Capabilities API returned ${capabilitiesResponse.status}`);
    }

    state.summary = (await summaryResponse.json()) as Summary;
    state.presets = (await presetsResponse.json()) as PresetWithPlan[];
    state.capabilities = (await capabilitiesResponse.json()) as Capability[];

    renderSummaryPanels();
    renderPresetPanels();
    renderTaskPanel();
    applyRunFilterValues();
    await loadRuns();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    getElement("summary-cards").innerHTML = `<p class="muted">Failed to load summary: ${escapeHtml(message)}</p>`;
    getElement("installed-capabilities").innerHTML =
      `<p class="muted">API unavailable.</p>`;
    getElement("capability-env").innerHTML =
      `<p class="muted">Env contract data unavailable.</p>`;
    getElement("preset-list").innerHTML =
      `<p class="muted">Preset data unavailable.</p>`;
    getElement("preset-detail").innerHTML =
      `<p class="muted">Preset detail unavailable.</p>`;
    getElement("task-list").innerHTML =
      `<p class="muted">Task data unavailable.</p>`;
    getElement("run-list").innerHTML =
      `<p class="muted">Run data unavailable.</p>`;
    getElement("run-detail").innerHTML =
      renderRunDetailPlaceholder("Run detail unavailable.");
  }
}

function renderSummaryPanels(): void {
  if (!state.summary) {
    return;
  }

  getElement("summary-cards").innerHTML = renderSummaryCards(state.summary);
  getElement("installed-capabilities").innerHTML = renderInstalledCapabilities(
    state.summary,
  );
  getElement("capability-env").innerHTML = renderCapabilityEnv(
    state.capabilities,
    state.summary,
  );
}

function renderPresetPanels(): void {
  getElement("preset-list").innerHTML = renderPresetList(
    state.presets,
    state.activePresetId,
  );
  const detail = renderPresetDetail(state.presets, state.activePresetId);
  state.activePresetId = detail.selectedPresetId;
  getElement("preset-detail").innerHTML = detail.html;
  syncSelectedRows("[data-preset-id]", state.activePresetId);
}

function renderTaskPanel(): void {
  if (!state.summary) {
    return;
  }

  getElement("task-list").innerHTML = renderTaskAvailability(state.summary);
}

async function loadRuns(): Promise<void> {
  const runList = getElement("run-list");

  try {
    const response = await fetch(`/api/runs${buildRunQuery(state.filters)}`);

    if (!response.ok) {
      throw new Error(`Runs API returned ${response.status}`);
    }

    state.runs = (await response.json()) as RunSummary[];
    renderRunFilters();
    runList.innerHTML = renderRunList(state.runs, state.activeRunId);
    state.activeRunId = selectActiveRunId(state.runs, state.activeRunId);
    syncSelectedRows("[data-run-id]", state.activeRunId);

    if (!state.activeRunId) {
      getElement("run-detail").innerHTML = renderRunDetailPlaceholder(
        "Choose a run from the list to inspect its payload, output, and events.",
      );
      return;
    }

    await loadRunDetail(state.activeRunId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runList.innerHTML = `<p class="muted">Run data unavailable: ${escapeHtml(message)}</p>`;
    getElement("run-detail").innerHTML = renderRunDetailPlaceholder(
      "Run detail unavailable.",
    );
  }
}

function renderRunFilters(): void {
  if (!state.summary) {
    return;
  }

  const options = renderRunFilterSelectOptions(
    state.summary,
    state.runs,
    state.filters,
  );

  getElement("run-filter-task").innerHTML = options.taskOptionsHtml;
  getElement("run-filter-source").innerHTML = options.sourceOptionsHtml;
  applyRunFilterValues();
}

function applyRunFilterValues(): void {
  const status = getElement("run-filter-status") as HTMLSelectElement;
  const task = getElement("run-filter-task") as HTMLSelectElement;
  const source = getElement("run-filter-source") as HTMLSelectElement;

  status.value = state.filters.status ?? "";
  task.value = state.filters.taskId ?? "";
  source.value = state.filters.source ?? "";
}

async function loadRunDetail(runId: string): Promise<void> {
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`);

    if (!response.ok) {
      throw new Error(`Run detail API returned ${response.status}`);
    }

    const run = (await response.json()) as RunDetail;
    getElement("run-detail").innerHTML = renderRunDetail(run);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    getElement("run-detail").innerHTML = renderRunDetailPlaceholder(
      `Failed to load run detail: ${message}`,
    );
  }
}
