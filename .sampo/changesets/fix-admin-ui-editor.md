---
npm/hooka: patch (Fixed)
---

The admin UI no longer overwrites the target editor on every live update, so unsaved edits survive and a new scaffold can no longer be saved over an existing target with the same id. Live updates are coalesced to at most one refresh per second, and ids rendered into HTML attributes are escaped.
