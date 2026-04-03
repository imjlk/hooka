import type {
  Capability,
  PresetWithPlan,
  RunDetail,
  RunFilters,
  RunSummary,
  Summary,
  Target,
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
import { renderPresetDetail, renderPresetList } from "./views/presets";
import {
  renderRunDetail,
  renderRunDetailPlaceholder,
  renderRunFilterSelectOptions,
  renderRunList,
} from "./views/runs";
import { renderTargetDetail, renderTargetList } from "./views/targets";

const adminTokenStorageKey = "hooka.adminToken";

const state: {
  activePresetId: string | null;
  activeRunId: string | null;
  activeTargetId: string | null;
  adminToken: string;
  capabilities: Capability[];
  eventSource: EventSource | null;
  filters: RunFilters;
  presets: PresetWithPlan[];
  runs: RunSummary[];
  summary: Summary | null;
  targets: Target[];
} = {
  activePresetId: null,
  activeRunId: null,
  activeTargetId: null,
  adminToken: localStorage.getItem(adminTokenStorageKey) ?? "",
  capabilities: [],
  eventSource: null,
  filters: {
    limit: 8,
  },
  presets: [],
  runs: [],
  summary: null,
  targets: [],
};

const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
  throw new Error("Root app container not found.");
}

root.innerHTML = renderShell();
setAuthStatus();
applyAdminTokenValue();

document.addEventListener("click", (event) => {
  const target = event.target;

  if (!(target instanceof HTMLElement)) {
    return;
  }

  const runTrigger = target.closest<HTMLElement>("[data-run-id]");

  if (runTrigger?.dataset["runId"]) {
    state.activeRunId = runTrigger.dataset["runId"];
    syncSelectedRows("[data-run-id]", state.activeRunId);
    void loadRunDetail(state.activeRunId);
    return;
  }

  const presetTrigger = target.closest<HTMLElement>("[data-preset-id]");

  if (presetTrigger?.dataset["presetId"]) {
    state.activePresetId = presetTrigger.dataset["presetId"];
    syncSelectedRows("[data-preset-id]", state.activePresetId);
    renderPresetPanels();
    return;
  }

  const targetTrigger = target.closest<HTMLElement>("[data-target-id]");

  if (targetTrigger?.dataset["targetId"]) {
    state.activeTargetId = targetTrigger.dataset["targetId"];
    syncSelectedRows("[data-target-id]", state.activeTargetId);
    renderTargetPanels();
    return;
  }

  const retryTrigger = target.closest<HTMLElement>("[data-run-retry-id]");

  if (retryTrigger?.dataset["runRetryId"]) {
    void retryRun(retryTrigger.dataset["runRetryId"]);
    return;
  }

  if (target.id === "run-refresh") {
    void hydrate();
    return;
  }

  if (target.id === "admin-token-save") {
    const input = getElement("admin-token") as HTMLInputElement;
    state.adminToken = input.value.trim();
    localStorage.setItem(adminTokenStorageKey, state.adminToken);
    setAuthStatus();
    connectEventStream();
    void hydrate();
    return;
  }

  if (target.id === "admin-token-clear") {
    state.adminToken = "";
    localStorage.removeItem(adminTokenStorageKey);
    applyAdminTokenValue();
    setAuthStatus();
    connectEventStream();
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
connectEventStream();

async function hydrate(): Promise<void> {
  try {
    const [summary, presets, capabilities, targets] = await Promise.all([
      fetchJson<Summary>("/api/summary"),
      fetchJson<PresetWithPlan[]>("/api/presets"),
      fetchJson<Capability[]>("/api/capabilities"),
      fetchJson<Target[]>("/api/targets"),
    ]);

    state.summary = summary;
    state.presets = presets;
    state.capabilities = capabilities;
    state.targets = targets;

    renderSummaryPanels();
    renderPresetPanels();
    renderTargetPanels();
    renderTaskPanel();
    applyRunFilterValues();
    await loadRuns();
    setAuthStatus();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    getElement("summary-cards").innerHTML =
      `<p class="muted">Failed to load summary: ${escapeHtml(message)}</p>`;
    getElement("installed-capabilities").innerHTML =
      `<p class="muted">API unavailable.</p>`;
    getElement("capability-env").innerHTML =
      `<p class="muted">Env contract data unavailable.</p>`;
    getElement("preset-list").innerHTML =
      `<p class="muted">Preset data unavailable.</p>`;
    getElement("preset-detail").innerHTML =
      `<p class="muted">Preset detail unavailable.</p>`;
    getElement("target-list").innerHTML =
      `<p class="muted">Target data unavailable.</p>`;
    getElement("target-detail").innerHTML =
      `<p class="muted">Target detail unavailable.</p>`;
    getElement("task-list").innerHTML =
      `<p class="muted">Task data unavailable.</p>`;
    getElement("run-list").innerHTML =
      `<p class="muted">Run data unavailable.</p>`;
    getElement("run-detail").innerHTML = renderRunDetailPlaceholder(
      "Run detail unavailable.",
    );
    setAuthStatus(message);
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

function renderTargetPanels(): void {
  getElement("target-list").innerHTML = renderTargetList(
    state.targets,
    state.activeTargetId,
  );
  const detail = renderTargetDetail(state.targets, state.activeTargetId);
  state.activeTargetId = detail.selectedTargetId;
  getElement("target-detail").innerHTML = detail.html;
  syncSelectedRows("[data-target-id]", state.activeTargetId);
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
    state.runs = await fetchJson<RunSummary[]>(
      `/api/runs${buildRunQuery(state.filters)}`,
    );
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
    const run = await fetchJson<RunDetail>(
      `/api/runs/${encodeURIComponent(runId)}`,
    );
    getElement("run-detail").innerHTML = renderRunDetail(run);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    getElement("run-detail").innerHTML = renderRunDetailPlaceholder(
      `Failed to load run detail: ${message}`,
    );
  }
}

async function retryRun(runId: string): Promise<void> {
  try {
    await fetchJson(`/api/runs/${encodeURIComponent(runId)}/retry`, {
      method: "POST",
    });
    await hydrate();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setAuthStatus(`Retry failed: ${message}`);
  }
}

async function fetchJson<T>(input: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});

  if (state.adminToken) {
    headers.set("authorization", `Bearer ${state.adminToken}`);
  }

  const response = await fetch(input, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

function connectEventStream(): void {
  state.eventSource?.close();
  state.eventSource = null;

  if (!state.adminToken) {
    return;
  }

  const token = encodeURIComponent(state.adminToken);
  const stream = new EventSource(`/api/events/stream?token=${token}`);
  stream.addEventListener("update", () => {
    void hydrate();
  });
  stream.onerror = () => {
    setAuthStatus("Live updates disconnected. Check admin token or refresh.");
  };
  state.eventSource = stream;
}

function setAuthStatus(message?: string): void {
  getElement("auth-status").textContent =
    message ??
    (state.adminToken
      ? "Admin token configured. Protected APIs and SSE are enabled."
      : "Enter the admin token to unlock protected APIs and live updates.");
}

function applyAdminTokenValue(): void {
  const input = getElement("admin-token") as HTMLInputElement;
  input.value = state.adminToken;
}
