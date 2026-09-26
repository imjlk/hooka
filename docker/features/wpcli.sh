#!/bin/sh
set -eux

# Pin WP-CLI and verify its published SHA-512 instead of installing whatever
# the current stable phar is without any integrity check.
WP_CLI_VERSION="2.12.0"
WP_CLI_SHA512="be928f6b8ca1e8dfb9d2f4b75a13aa4aee0896f8a9a0a1c45cd5d2c98605e6172e6d014dda2e27f88c98befc16c040cbb2bd1bfa121510ea5cdf5f6a30fe8832"

# php-cli alone lacks Phar (the wp binary could not start) and the mysqli,
# mbstring, and openssl extensions WordPress needs to boot for `wp eval`.
apk add --no-cache bash curl php-cli php-phar php-mysqli php-mbstring \
  php-openssl php-curl php-iconv php-ctype php-tokenizer
curl -fsSL "https://github.com/wp-cli/wp-cli/releases/download/v${WP_CLI_VERSION}/wp-cli-${WP_CLI_VERSION}.phar" -o /usr/local/bin/wp
echo "${WP_CLI_SHA512}  /usr/local/bin/wp" | sha512sum -c -
chmod +x /usr/local/bin/wp
