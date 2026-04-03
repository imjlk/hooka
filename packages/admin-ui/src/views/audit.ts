import { escapeHtml } from "../dom";
import type { AuditEvent } from "../helpers";

export function renderAuditList(auditEvents: AuditEvent[]): string {
  if (auditEvents.length === 0) {
    return `<p class="muted">No audit events recorded.</p>`;
  }

  return auditEvents
    .map(
      (event) => `
        <article class="detail-card audit-card">
          <div class="detail-grid">
            <div>
              <span class="eyebrow">${escapeHtml(event.category)}</span>
              <h3>${escapeHtml(event.action)}</h3>
              <p>${escapeHtml(event.message)}</p>
            </div>
            <div class="stack">
              <span class="chip">${escapeHtml(event.outcome)}</span>
              ${event.subjectId ? `<span class="chip">${escapeHtml(event.subjectId)}</span>` : ""}
              ${event.clientIp ? `<span class="chip">${escapeHtml(event.clientIp)}</span>` : ""}
            </div>
          </div>
          <p class="muted">${escapeHtml(event.createdAt)}</p>
        </article>
      `,
    )
    .join("");
}
