---
npm/hooka: patch (Fixed)
---

Process task timeouts now stop the whole process group and escalate to SIGKILL, the default timeout is 10 minutes instead of 60 seconds so larger Pages deploys and rclone copies are not cut off, captured output is bounded, spawned tools no longer inherit `HOOKA_ADMIN_TOKEN` or `HOOKA_WEBHOOK_SECRET`, and HTTP tasks stop retrying deterministic `4xx` failures.
