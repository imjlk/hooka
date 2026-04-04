import { escapeHtml } from "../dom";
import { selectTarget, type Target } from "../helpers";

export function renderTargetList(
  targets: Target[],
  activeTargetId: string | null,
): string {
  return targets.length > 0
    ? targets
        .map((target) => {
          const selected = target.id === activeTargetId ? " selected" : "";
          return `
            <button type="button" class="task-row run-row${selected}" data-target-id="${target.id}">
              <div>
                <strong>${escapeHtml(target.id)}</strong>
                <p>${escapeHtml(target.taskId)}</p>
                <p>${escapeHtml(target.description ?? target.title)}</p>
              </div>
              <div class="task-meta">
                <span class="chip">${escapeHtml(target.source)}</span>
                <span class="chip">${target.maxAttempts} attempts</span>
              </div>
            </button>
          `;
        })
        .join("")
    : `<p class="muted">No targets configured.</p>`;
}

export function renderTargetDetail(
  targets: Target[],
  activeTargetId: string | null,
): {
  html: string;
  target: Target | null;
  selectedTargetId: string | null;
} {
  const target = selectTarget(targets, activeTargetId);

  if (!target) {
    return {
      target: null,
      selectedTargetId: null,
      html: `<p class="muted">No target data is available.</p>`,
    };
  }

  return {
    target,
    selectedTargetId: target.id,
    html: `
      <div class="detail-grid">
        <div class="detail-card">
          <span class="eyebrow">Target</span>
          <h3>${escapeHtml(target.id)}</h3>
          <p>${escapeHtml(target.description ?? target.title)}</p>
          <div class="stack">
            <span class="chip">${escapeHtml(target.taskId)}</span>
            <span class="chip">${escapeHtml(target.source)}</span>
            <span class="chip">${target.maxAttempts} attempts</span>
          </div>
        </div>
        <div class="detail-card">
          <span class="eyebrow">Default Input</span>
          <pre>${escapeHtml(JSON.stringify(target.defaultInput, null, 2))}</pre>
        </div>
      </div>
      <div class="detail-grid">
        <div class="detail-card">
          <span class="eyebrow">Policy</span>
          <div class="stack">
            ${target.policy.allowedProjects.map((project) => `<span class="chip">${escapeHtml(project)}</span>`).join("") || '<span class="chip">projects:any</span>'}
            ${target.policy.allowedSourceRoots.map((root) => `<span class="chip">${escapeHtml(root)}</span>`).join("") || '<span class="chip">source:any</span>'}
            ${target.policy.allowedDestinationPrefixes.map((destination) => `<span class="chip">${escapeHtml(destination)}</span>`).join("") || '<span class="chip">destination:any</span>'}
            ${target.policy.allowedBranches.map((branch) => `<span class="chip">${escapeHtml(branch)}</span>`).join("") || '<span class="chip">branch:any</span>'}
          </div>
        </div>
        <div class="detail-card">
          <span class="eyebrow">Artifact Readiness</span>
          <pre>${escapeHtml(JSON.stringify(target.policy.artifactReadiness, null, 2))}</pre>
        </div>
      </div>
    `,
  };
}
