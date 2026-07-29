#!/bin/sh
set -eu

usage() {
  printf '%s\n' \
    "usage: agent-run-shell <task-root> <relative-cwd> <timeout-ms> <command>" >&2
  exit 64
}

[ "$#" -eq 4 ] || usage

requested_root=$1
relative_cwd=$2
timeout_ms=$3
command=$4

case "$requested_root" in
  /workspace/tasks/*) ;;
  *) printf '%s\n' "refusing task root outside /workspace/tasks" >&2; exit 65 ;;
esac
case "$relative_cwd" in
  ""|/*|*".."*|*\\*|*//*)
    printf '%s\n' "invalid relative working directory" >&2
    exit 65
    ;;
esac
case "$timeout_ms" in
  ""|*[!0-9]*) printf '%s\n' "invalid timeout" >&2; exit 65 ;;
esac
[ "$timeout_ms" -gt 0 ] ||
  { printf '%s\n' "invalid timeout" >&2; exit 65; }

task_root=$(realpath -e -- "$requested_root") ||
  { printf '%s\n' "task root does not exist" >&2; exit 65; }
case "$task_root" in
  /workspace/tasks/*) ;;
  *) printf '%s\n' "resolved task root escaped /workspace/tasks" >&2; exit 65 ;;
esac

working_directory=$(realpath -e -- "$task_root/$relative_cwd") ||
  { printf '%s\n' "working directory does not exist" >&2; exit 65; }
case "$working_directory" in
  "$task_root"|"$task_root"/*) ;;
  *) printf '%s\n' "resolved working directory escaped task root" >&2; exit 65 ;;
esac

cleanup_runner() {
  pkill -KILL -u runner 2>/dev/null || true
}
trap cleanup_runner EXIT HUP INT TERM

set +e
setpriv \
  --reuid=runner \
  --regid=runner \
  --init-groups \
  --no-new-privs \
  env -i \
    PATH=/usr/local/bin:/usr/bin:/bin \
    HOME=/home/runner \
    TMPDIR=/tmp \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TASK_ROOT="$task_root" \
  timeout --signal=TERM --kill-after=1s "${timeout_ms}ms" \
  /bin/sh -c "cd \"\$1\" && exec /bin/sh -c \"\$2\"" sh \
  "$working_directory" "$command"
status=$?
set -e

exit "$status"
