import type { Capability, Summary } from "../helpers";
import { formatCapabilityEnvRows } from "../helpers";
import { escapeHtml, metricCard } from "../dom";

export function renderSummaryCards(summary: Summary): string {
  return [
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
}

export function renderInstalledCapabilities(summary: Summary): string {
  return summary.installedCapabilities.length > 0
    ? summary.installedCapabilities
        .map((capability) => `<span class="chip">${escapeHtml(capability)}</span>`)
        .join("")
    : `<p class="muted">No capability manifest loaded yet.</p>`;
}

export function renderCapabilityEnv(
  capabilities: Capability[],
  summary: Summary,
): string {
  const envRows = formatCapabilityEnvRows(
    capabilities,
    summary.installedCapabilities,
  );

  return envRows.length > 0
    ? envRows
        .map(
          (row) => `
            <div class="detail-card compact-card">
              <strong>${escapeHtml(row.capabilityId)}</strong>
              <p>${escapeHtml(row.description)}</p>
              <div class="stack">
                <span class="chip">${escapeHtml(row.mode)}</span>
                ${row.secret ? '<span class="chip">secret</span>' : ""}
              </div>
              <div class="stack">
                ${row.names
                  .map((name) => `<span class="chip">${escapeHtml(name)}</span>`)
                  .join("")}
              </div>
            </div>
          `,
        )
        .join("")
    : `<p class="muted">No env contracts apply to the current installed capabilities.</p>`;
}

export function renderTaskAvailability(summary: Summary): string {
  return summary.tasks
    .map((task) => {
      const statusClass = task.available ? "available" : "blocked";
      const statusLabel = task.available ? "ready" : "missing";

      return `
        <div class="task-row">
          <div>
            <strong>${escapeHtml(task.id)}</strong>
            <p>${escapeHtml(task.title)}</p>
          </div>
          <div class="task-meta">
            <div class="chips">
              ${task.requires
                .map((requirement) => `<span class="chip">${escapeHtml(requirement)}</span>`)
                .join("")}
            </div>
            <span class="status ${statusClass}">${statusLabel}</span>
          </div>
        </div>
      `;
    })
    .join("");
}
