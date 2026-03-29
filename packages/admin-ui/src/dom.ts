export function getElement(id: string): HTMLElement {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing element #${id}`);
  }

  return element;
}

export function syncSelectedRows(selector: string, activeId: string | null): void {
  for (const button of document.querySelectorAll<HTMLElement>(selector)) {
    const selectedId = button.dataset.runId ?? button.dataset.presetId ?? null;
    button.classList.toggle("selected", selectedId === activeId);
  }
}

export function metricCard(label: string, value: string): string {
  return `
    <div class="metric-card">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `;
}

export function runStatusClass(status: string): string {
  if (status === "succeeded") {
    return "available";
  }

  if (status === "queued" || status === "running") {
    return "pending";
  }

  return "blocked";
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatTimestamp(value: string | null): string {
  if (!value) {
    return "Not recorded";
  }

  return new Date(value).toLocaleString();
}
