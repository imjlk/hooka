import { escapeHtml } from "../dom";
import { selectPreset, type PresetWithPlan } from "../helpers";

export function renderPresetList(
  presets: PresetWithPlan[],
  activePresetId: string | null,
): string {
  return presets
    .map((preset) => {
      const selected = preset.id === activePresetId ? " selected" : "";
      return `
        <button type="button" class="task-row run-row${selected}" data-preset-id="${preset.id}">
          <div>
            <strong>${escapeHtml(preset.id)}</strong>
            <p>${escapeHtml(preset.publicWorkerTag ?? preset.imageTag)}</p>
            <p>${escapeHtml(preset.description)}</p>
          </div>
          <div class="task-meta">
            <span class="chip">${escapeHtml(preset.tier ?? "preset")}</span>
            <span class="chip">${preset.plan?.coveredTasks.length ?? 0} tasks</span>
            <span class="chip">${preset.capabilities.length} caps</span>
          </div>
        </button>
      `;
    })
    .join("");
}

export function renderPresetDetail(
  presets: PresetWithPlan[],
  activePresetId: string | null,
): {
  html: string;
  selectedPresetId: string | null;
} {
  const preset = selectPreset(presets, activePresetId);

  if (!preset) {
    return {
      selectedPresetId: null,
      html: `<p class="muted">No preset data is available.</p>`,
    };
  }

  const plan = preset.plan;
  return {
    selectedPresetId: preset.id,
    html: `
      <div class="detail-grid">
        <div class="detail-card">
          <span class="eyebrow">Preset</span>
          <h3>${escapeHtml(preset.id)}</h3>
          <p>${escapeHtml(preset.description)}</p>
          <div class="stack">
            <span class="chip">${escapeHtml(preset.publicWorkerTag ?? preset.imageTag)}</span>
            <span class="chip">${escapeHtml(preset.tier ?? "preset")}</span>
          </div>
        </div>
        <div class="detail-card">
          <span class="eyebrow">Capabilities</span>
          <div class="stack">
            ${
              preset.capabilities.length > 0
                ? preset.capabilities
                    .map((capability) => `<span class="chip">${escapeHtml(capability)}</span>`)
                    .join("")
                : `<p class="muted">No extra capabilities required.</p>`
            }
          </div>
        </div>
      </div>
      <div class="detail-grid">
        <div class="detail-card">
          <span class="eyebrow">Required Env</span>
          ${
            plan && plan.requiredEnv.length > 0
              ? plan.requiredEnv
                  .map(
                    (requirement) => `
                      <div class="env-row">
                        <strong>${escapeHtml(requirement.capabilityId)}</strong>
                        <p>${escapeHtml(requirement.description)}</p>
                        <div class="stack">
                          <span class="chip">${escapeHtml(requirement.match)}</span>
                          ${requirement.names
                            .map((name) => `<span class="chip">${escapeHtml(name)}</span>`)
                            .join("")}
                        </div>
                      </div>
                    `,
                  )
                  .join("")
              : `<p class="muted">No env contracts recorded for this preset.</p>`
          }
        </div>
        <div class="detail-card">
          <span class="eyebrow">Covered Tasks</span>
          <div class="stack">
            ${
              plan && plan.coveredTasks.length > 0
                ? plan.coveredTasks
                    .map((taskId) => `<span class="chip">${escapeHtml(taskId)}</span>`)
                    .join("")
                : `<p class="muted">No tasks covered.</p>`
            }
          </div>
        </div>
      </div>
    `,
  };
}
