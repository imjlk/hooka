import { escapeHtml } from "../dom";
import { summarizeAuditContext, type AuditEvent } from "../helpers";

export function renderAuditList(auditEvents: AuditEvent[]): string {
  if (auditEvents.length === 0) {
    return `<p class="muted">No audit events recorded.</p>`;
  }

  return auditEvents
    .map((event) => {
      const contextPreview = summarizeAuditContext(event.context);
      const subjectLabel = event.subjectId
        ? `${event.subjectType}:${event.subjectId}`
        : event.subjectType;

      return `
        <article class="detail-card audit-card">
          <div class="stack audit-meta">
            <span class="chip">${escapeHtml(event.category)}</span>
            <span class="chip">${escapeHtml(event.outcome)}</span>
            <span class="chip">${escapeHtml(subjectLabel)}</span>
            ${event.clientIp ? `<span class="chip">${escapeHtml(event.clientIp)}</span>` : ""}
            ${event.requestPath ? `<span class="chip">${escapeHtml(event.requestPath)}</span>` : ""}
          </div>
          <h3>${escapeHtml(event.action)}</h3>
          <p>${escapeHtml(event.message)}</p>
          ${contextPreview ? `<p class="muted">Context: ${escapeHtml(contextPreview)}</p>` : ""}
          <p class="muted">${escapeHtml(event.createdAt)}</p>
        </article>
      `;
    })
    .join("");
}
