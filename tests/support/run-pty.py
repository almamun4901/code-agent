#!/usr/bin/env python3

import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import subprocess
import sys
import termios
import time
import struct


def terminal_flags(attributes):
    return attributes[:4]


master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
before = terminal_flags(termios.tcgetattr(master))
started_at = time.monotonic()
process = subprocess.Popen(
    sys.argv[1:],
    stdin=slave,
    stdout=slave,
    stderr=subprocess.PIPE,
    close_fds=True,
)
os.close(slave)
output = bytearray()
error_output = bytearray()
first_output_ms = None
sent_sigint = False

while True:
    readable = [master]
    if process.stderr is not None:
        readable.append(process.stderr.fileno())
    ready, _, _ = select.select(readable, [], [], 0.05)
    if master in ready:
        try:
            chunk = os.read(master, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            chunk = b""
        if chunk:
            output.extend(chunk)
            if first_output_ms is None:
                first_output_ms = (time.monotonic() - started_at) * 1000
            if (
                os.environ.get("PTY_SEND_SIGINT") == "1"
                and not os.environ.get("PTY_TRIGGER")
                and not sent_sigint
            ):
                os.kill(process.pid, signal.SIGINT)
                sent_sigint = True
    if process.stderr is not None and process.stderr.fileno() in ready:
        chunk = os.read(process.stderr.fileno(), 65536)
        if chunk:
            error_output.extend(chunk)
            trigger = os.environ.get("PTY_TRIGGER", "").encode("utf-8")
            if (
                os.environ.get("PTY_SEND_SIGINT") == "1"
                and trigger
                and trigger in error_output
                and not sent_sigint
            ):
                os.kill(process.pid, signal.SIGINT)
                sent_sigint = True
    if process.poll() is not None:
        while True:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
            if not chunk:
                break
            output.extend(chunk)
        if process.stderr is not None:
            error_output.extend(process.stderr.read() or b"")
        break

after = terminal_flags(termios.tcgetattr(master))
os.close(master)
print(json.dumps({
    "returnCode": process.returncode,
    "firstOutputMs": first_output_ms,
    "elapsedMs": (time.monotonic() - started_at) * 1000,
    "terminalRestored": before == after,
    "output": base64.b64encode(output).decode("ascii"),
    "stderr": base64.b64encode(error_output).decode("ascii"),
}))
