variable "REGISTRY" {
  default = "ghcr.io/imjlk/hooka"
}

target "base" {
  context = "."
  dockerfile = "docker/Dockerfile"
  platforms = ["linux/amd64", "linux/arm64"]
}

target "core" {
  inherits = ["base"]
  args = {
    HOOKA_FEATURES = "core"
  }
  tags = ["${REGISTRY}:core"]
}

target "cf-wrangler" {
  inherits = ["base"]
  args = {
    HOOKA_FEATURES = "wrangler,git"
  }
  tags = ["${REGISTRY}:cf-wrangler"]
}

target "wp-wrangler" {
  inherits = ["base"]
  args = {
    HOOKA_FEATURES = "wrangler,wpcli,php-cli,rsync,git"
  }
  tags = ["${REGISTRY}:wp-wrangler"]
}

target "wp-wrangler-rclone" {
  inherits = ["base"]
  args = {
    HOOKA_FEATURES = "wrangler,wpcli,php-cli,rsync,git,rclone"
  }
  tags = ["${REGISTRY}:wp-wrangler-rclone"]
}

group "release" {
  targets = ["core", "cf-wrangler", "wp-wrangler", "wp-wrangler-rclone"]
}
