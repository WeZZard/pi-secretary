#!/usr/bin/env python3
"""Drive normal interactive Pi over an owned PTY; never open or control the user's terminal."""
import argparse
import codecs
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import termios
import time

parser = argparse.ArgumentParser()
parser.add_argument("--artifacts", required=True)
parser.add_argument("--observer", required=True)
parser.add_argument("--prompt-file", required=True)
parser.add_argument("--ready-text", required=True)
parser.add_argument("--timeout", type=float, default=180)
parser.add_argument("command", nargs=argparse.REMAINDER)
args = parser.parse_args()
command = args.command[1:] if args.command[:1] == ["--"] else args.command
out = Path(args.artifacts)
out.mkdir(exist_ok=False)
observer = Path(args.observer)
columns, rows = 120, 38
started = time.monotonic()
events, checkpoints = [], []
raw = ""
query_tail = ""
decoder = codecs.getincrementaldecoder("utf-8")("replace")
pid = fd = None
exit_status = None
failure = None
parent_id = None
completed = False
cleanup = "not started"

def interrupted(signum, _frame):
    raise InterruptedError(f"Terminal driver received signal {signum}")

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)

def elapsed():
    return round(time.monotonic() - started, 6)

def send(value, record=True):
    if record:
        events.append([elapsed(), "i", value])
    data = value.encode()
    while data:
        written = os.write(fd, data)
        data = data[written:]

def pump(timeout=0.05):
    global raw, query_tail
    if not select.select([fd], [], [], timeout)[0]:
        return
    try:
        data = os.read(fd, 65536)
    except OSError as error:
        if error.errno == errno.EIO:
            raise EOFError("Pi closed its terminal") from error
        raise
    if not data:
        raise EOFError("Pi closed its terminal")
    text = decoder.decode(data)
    raw += text
    events.append([elapsed(), "o", text])
    if len(raw) > 16_000_000:
        raise RuntimeError("Terminal output exceeded the recording bound")
    combined = query_tail + text
    if "\x1b[6n" in combined:
        send("\x1b[1;1R", False)
    if "\x1b[c" in combined or "\x1b[0c" in combined:
        send("\x1b[?1;2c", False)
    if "\x1b[?u" in combined:
        send("\x1b[?0u", False)
    query_tail = combined[-3:]

def observations():
    result = []
    if observer.exists():
        for line in observer.read_text().splitlines():
            try:
                result.append(json.loads(line))
            except json.JSONDecodeError:
                pass  # The last append may still be in progress.
    return result

def wait_for(predicate, label, timeout):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            raise TimeoutError("Timed out waiting for " + label)
        pump()

def checkpoint(name):
    wait_for(lambda: raw.count("\x1b[?2026h") == raw.count("\x1b[?2026l"), "complete terminal repaint", 10)
    checkpoints.append({"name": name, "eventIndex": len(events), "columns": columns, "rows": rows, "time": elapsed()})

try:
    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        os.execvpe(command[0], command, os.environ)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    wait_for(lambda: any(e["event"] == "session_start" and e["mode"] == "tui" and e["hasUI"] for e in observations()), "interactive parent startup", 60)
    parent_id = next(e["sessionId"] for e in observations() if e["event"] == "session_start" and e["mode"] == "tui")
    wait_for(lambda: args.ready_text in raw and "\x1b[?2026l" in raw, "painted model/editor", 30)
    checkpoint("tui-ready")
    prompt = Path(args.prompt_file).read_text().strip()
    send("\x1b[200~" + prompt + "\x1b[201~")
    send("\r")
    checkpoint("tui-submitted")
    wait_for(lambda: any(e["event"] == "agent_end" and e["sessionId"] == parent_id for e in observations()), "parent completion after delegation", args.timeout)
    # Drain the completion repaint; this is a bounded capture interval, not a success assertion.
    deadline = time.monotonic() + 0.75
    while time.monotonic() < deadline:
        pump()
    checkpoint("tui-result")
    completed = True
    send("\x15/quit\r")
    cleanup = "quit command"
except Exception as error:
    failure = f"{type(error).__name__}: {error}"
finally:
    if pid and pid > 0:
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            found, status = os.waitpid(pid, os.WNOHANG)
            if found:
                exit_status = status
                break
            try:
                pump()
            except (EOFError, OSError):
                time.sleep(0.02)
        if exit_status is None:
            cleanup = "SIGTERM fallback"
            os.kill(pid, signal.SIGTERM)
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                found, status = os.waitpid(pid, os.WNOHANG)
                if found:
                    exit_status = status
                    break
                time.sleep(0.05)
        if exit_status is None:
            cleanup = "SIGKILL fallback"
            os.kill(pid, signal.SIGKILL)
            _, exit_status = os.waitpid(pid, 0)
    if fd is not None:
        os.close(fd)
    with (out / "walkthrough.cast").open("w") as cast:
        cast.write(json.dumps({"version": 2, "width": columns, "height": rows,
                               "title": "Real-provider interactive Pi subagent spawning", "env": {"TERM": "xterm-256color"}}) + "\n")
        for event in events:
            cast.write(json.dumps(event) + "\n")
    (out / "checkpoints.json").write_text(json.dumps(checkpoints, indent=2) + "\n")
    (out / "result.json").write_text(json.dumps({"completedInteraction": completed, "failure": failure,
        "parentSessionId": parent_id, "exitCode": os.waitstatus_to_exitcode(exit_status) if exit_status is not None else None,
        "cleanup": cleanup, "interactive": True, "terminal": "owned POSIX PTY", "humanReview": "not performed"}, indent=2) + "\n")
if failure:
    print(failure)
    raise SystemExit(1)
