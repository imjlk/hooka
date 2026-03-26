# WordPress Producer Example

Hooka's default webhook ingress is generic:

- `POST /api/webhooks/task`
- HMAC headers: `x-hooka-timestamp`, `x-hooka-signature`
- the worker, not the server, must see the producer's shared source volume
- for a lean deployment, pair `hooka:webhook-server` with `hooka:cf-pages`
- if you also want `wp-cli` tasks in the same worker, pair it with `hooka:wp-wrangler`
- body shape:

```json
{
  "taskId": "deploy.shared-volume.wrangler",
  "input": {
    "kind": "pages-deploy",
    "project": "staging-site",
    "sourcePath": "/shared-source/simply-static",
    "branch": "main"
  },
  "eventId": "evt_123",
  "source": "wordpress.webhook"
}
```

Use this from WordPress as a plain signed webhook caller. A simple PHP example:

```php
<?php
$secret = getenv('HOOKA_WEBHOOK_SECRET');
$timestamp = (string) time();
$payload = wp_json_encode([
  'taskId' => 'deploy.shared-volume.wrangler',
  'input' => [
    'kind' => 'pages-deploy',
    'project' => 'staging-site',
    'sourcePath' => '/shared-source/simply-static',
    'branch' => 'main',
  ],
  'eventId' => 'evt_' . wp_generate_uuid4(),
  'source' => 'wordpress.webhook',
]);
$signature = hash_hmac('sha256', $timestamp . '.' . $payload, $secret);

wp_remote_post('https://hooka.example.com/api/webhooks/task', [
  'headers' => [
    'Content-Type' => 'application/json',
    'x-hooka-timestamp' => $timestamp,
    'x-hooka-signature' => 'sha256=' . $signature,
  ],
  'body' => $payload,
  'timeout' => 15,
]);
```

In practice the WordPress container owns the export directory and the Hooka worker mounts that same volume at `/shared-source`. For the Simply Static example, call the snippet from either:

- the point where your export zip has been generated
- the point where your local deploy has completed

You do not need a dedicated Hooka plugin here. A site-specific snippet or mini integration is enough.
