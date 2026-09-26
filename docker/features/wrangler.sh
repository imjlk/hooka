#!/bin/sh
set -eux

# Pin wrangler so image rebuilds are reproducible and a new major release
# cannot silently change `pages deploy` behavior.
bun add -g wrangler@4.141.0
