variable "REGISTRY" {
  default = "ghcr.io/imjlk/hooka"
}

target "base" {
  context = "."
  dockerfile = "docker/Dockerfile"
  platforms = ["linux/amd64", "linux/arm64"]
}

target "webhook-server" {
  inherits = ["base"]
  target = "webhook-server"
  tags = ["${REGISTRY}:webhook-server"]
}

target "core" {
  inherits = ["base"]
  target = "worker-preset"
  args = {
    HOOKA_FEATURES = "core"
    HOOKA_IMAGE_LABEL = "hooka:core"
    HOOKA_RUNTIME_ROLE = "worker:core"
    HOOKA_INSTALLED_CAPABILITIES = ""
  }
  tags = ["${REGISTRY}:core"]
}

target "cf-pages" {
  inherits = ["base"]
  target = "worker-preset"
  args = {
    HOOKA_FEATURES = "wrangler"
    HOOKA_IMAGE_LABEL = "hooka:cf-pages"
    HOOKA_RUNTIME_ROLE = "worker:cf-pages"
    HOOKA_INSTALLED_CAPABILITIES = "wrangler"
  }
  tags = ["${REGISTRY}:cf-pages", "${REGISTRY}:cf-wrangler", "${REGISTRY}:wrangler-worker"]
}

target "cf-cache" {
  inherits = ["base"]
  target = "worker-preset"
  args = {
    HOOKA_FEATURES = "cloudflare-api"
    HOOKA_IMAGE_LABEL = "hooka:cf-cache"
    HOOKA_RUNTIME_ROLE = "worker:cf-cache"
    HOOKA_INSTALLED_CAPABILITIES = "cloudflare-api"
  }
  tags = ["${REGISTRY}:cf-cache"]
}

target "wp-ops" {
  inherits = ["base"]
  target = "worker-preset"
  args = {
    HOOKA_FEATURES = "wpcli,php-cli"
    HOOKA_IMAGE_LABEL = "hooka:wp-ops"
    HOOKA_RUNTIME_ROLE = "worker:wp-ops"
    HOOKA_INSTALLED_CAPABILITIES = "wpcli,php-cli"
  }
  tags = ["${REGISTRY}:wp-ops"]
}

target "rclone-sync" {
  inherits = ["base"]
  target = "worker-preset"
  args = {
    HOOKA_FEATURES = "rclone"
    HOOKA_IMAGE_LABEL = "hooka:rclone-sync"
    HOOKA_RUNTIME_ROLE = "worker:rclone-sync"
    HOOKA_INSTALLED_CAPABILITIES = "rclone"
  }
  tags = ["${REGISTRY}:rclone-sync"]
}

target "wp-wrangler" {
  inherits = ["base"]
  target = "worker-preset"
  args = {
    HOOKA_FEATURES = "wrangler,wpcli,php-cli"
    HOOKA_IMAGE_LABEL = "hooka:wp-wrangler"
    HOOKA_RUNTIME_ROLE = "worker:wp-wrangler"
    HOOKA_INSTALLED_CAPABILITIES = "wrangler,wpcli,php-cli"
  }
  tags = ["${REGISTRY}:wp-wrangler", "${REGISTRY}:webhook-wrangler"]
}

group "release" {
  targets = ["webhook-server", "core", "cf-pages", "cf-cache", "wp-ops", "rclone-sync", "wp-wrangler"]
}
