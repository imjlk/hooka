export function renderShell(): string {
  return `
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
            <h2>Required Env</h2>
            <span class="pill">contracts</span>
          </div>
          <div id="capability-env" class="stack detail-stack"></div>
        </article>
      </section>

      <section class="grid">
        <article class="panel">
          <div class="panel-head">
            <h2>Preset Catalog</h2>
            <span class="pill">images</span>
          </div>
          <div id="preset-list" class="stack task-list"></div>
        </article>

        <article class="panel">
          <div class="panel-head">
            <h2>Preset Detail</h2>
            <span class="pill">plan</span>
          </div>
          <div id="preset-detail" class="detail-panel">
            <p class="muted">Choose a preset to inspect capabilities, required env, and covered tasks.</p>
          </div>
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
        <div class="toolbar">
          <label class="field">
            <span>Status</span>
            <select id="run-filter-status">
              <option value="">All</option>
              <option value="queued">queued</option>
              <option value="running">running</option>
              <option value="succeeded">succeeded</option>
              <option value="failed">failed</option>
              <option value="skipped">skipped</option>
            </select>
          </label>
          <label class="field">
            <span>Task</span>
            <select id="run-filter-task">
              <option value="">All</option>
            </select>
          </label>
          <label class="field">
            <span>Source</span>
            <select id="run-filter-source">
              <option value="">All</option>
            </select>
          </label>
          <button type="button" id="run-refresh" class="action-button">Refresh</button>
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
}
