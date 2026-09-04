#!/bin/sh
set -eu

secret_value=${SOURCE_PROXY_SECRET:-}
secret_length=${#secret_value}
invalid_secret=false
case "${secret_value}" in
  ""|*[!A-Za-z0-9_-]*) invalid_secret=true ;;
esac
if [ "${secret_length}" -lt 32 ] || [ "${secret_length}" -gt 128 ] ||
  [ "${invalid_secret}" = true ]; then
  echo "OpenArc M04 web proxy configuration is invalid" >&2
  exit 1
fi
