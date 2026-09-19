#!/usr/bin/env python3
"""Drive interactive Pi over an owned PTY for the agents-widget storage-lock reproducer.

Phases: wait for interactive startup, submit the agent-launch prompt, wait for
the launch turn to complete, confirm the Agent tool call in the parent session
transcript (so the launch cannot be misread), wait for the async-agents widget
to mount through the probe, signal the test through a marker file, idle for a
bounded observation window (during which the test holds an external write lock
on the goals database), then quit cleanly — or report that Pi died on its own.

This mirrors storage-lock-terminal-process.py with a longer launch turn and a
transcript-verified Agent tool call instead of the goal widget mount.
"""
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
parser.add_argument("--widget-marker", required=True,
                    help="Written once the async-agents widget is mounted and the launch turn has completed")
parser.add_argument("--idle-seconds", type=float, default=6,
                    help="Observation window after the widget mounts")
parser.add_argument("--timeout", type=float, default=330,
                    help="Overall driver timeout")
parser.add_argument("--turn-timeout", type=float, default=300,
                    help="Timeout for the agent-launch turn")
parser.add_argument("command", nargs=argparse.REMAINDER)
args = parser.parse_args()
command = args.command[1:] if args.command[:1] == ["--"] else args.command
out = Path(args.artifacts)
out.mkdir(exist_ok=False)
observer = Path(args.observer)
marker = Path(args.widget_marker)
columns, rows = 120, 38
started = time.monotonic()
events, checkpoints = [], []
raw = ""
query_tail = ""
decoder = codecs.getincrementaldecoder("utf-8")("replace")
pid = fd = None
exit_status = None
failure = None
died = None
parent_id = None
parent_session_file = None
completed = False
cleanup = "not started"
reaped = False

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

def child_gone():
    global exit_status, reaped
    if pid is None or pid <= 0 or reaped:
        return reaped
    found, status = os.waitpid(pid, os.WNOHANG)
    if found:
        reaped = True
        exit_status = status
    return bool(found)

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

def probe_events():
    result = []
    probe = marker.parent / "probe-events.jsonl"
    if probe.exists():
        for line in probe.read_text().splitlines():
            try:
                result.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return result

def agent_tool_called():
    if not parent_session_file or not Path(parent_session_file).exists():
        return False
    try:
        for line in Path(parent_session_file).read_text().splitlines():
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            message = entry.get("message") or {}
            if message.get("role") != "assistant":
                continue
            for block in message.get("content") or []:
                if block.get("type") == "toolCall" and block.get("name") == "Agent":
                    return True
    except OSError:
        return False
    return False

def wait_for(predicate, label, timeout):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            raise TimeoutError("Timed out waiting for " + label)
        pump()
        if child_gone():
            raise EOFError("Pi exited while waiting for " + label)

def checkpoint(name):
    wait_for(lambda: raw.count("\x1b[?2026h") == raw.count("\x1b[?2026l"), "complete terminal repaint", 10)
    checkpoints.append({"name": name, "eventIndex": len(events), "columns": columns, "rows": rows, "time": elapsed()})

try:
    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        os.execvpe(command[0], command, os.environ)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    wait_for(lambda: any(e["event"] == "session_start" and e["mode"] == "tui" and e["hasUI"] for e in observations()),
             "interactive parent startup", 60)
    parent = next(e for e in observations() if e["event"] == "session_start" and e["mode"] == "tui")
    parent_id = parent["sessionId"]
    parent_session_file = parent.get("sessionFile")
    wait_for(lambda: args.ready_text in raw and "\x1b[?2026l" in raw, "painted model/editor", 30)
    checkpoint("tui-ready")
    prompt = Path(args.prompt_file).read_text().strip()
    send("\x1b[200~" + prompt + "\x1b[201~")
    send("\r")
    checkpoint("tui-submitted")
    wait_for(lambda: any(e["event"] == "agent_end" and e["sessionId"] == parent_id for e in observations()),
             "agent launch turn completion", args.turn_timeout)
    wait_for(agent_tool_called, "Agent tool call in the parent session transcript", 30)
    wait_for(lambda: any(e.get("event") == "widget" and e.get("id") == "secretary.agents.async" and e.get("mounted") is True
                         for e in probe_events()),
             "async-agents widget mount", 30)
    checkpoint("widget-mounted")
    # The async-agents widget now re-renders every 500 ms. Signal the test to
    # take the external write lock, then keep pumping output for the window.
    marker.write_text(json.dumps({"mounted": True, "time": elapsed()}) + "\n")
    idle_deadline = time.monotonic() + args.idle_seconds
    while time.monotonic() < idle_deadline:
        if child_gone():
            died = "pi exited during the locked observation window"
            break
        try:
            pump()
        except EOFError:
            died = "pi closed its terminal during the locked observation window"
            break
    checkpoint("observation-complete")
    completed = True
    if died is None:
        send("\x15/quit\r")
        cleanup = "quit command"
    else:
        cleanup = "pi already gone"
except Exception as error:
    failure = f"{type(error).__name__}: {error}"
finally:
    if pid and pid > 0 and not reaped:
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            found, status = os.waitpid(pid, os.WNOHANG)
            if found:
                reaped = True
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
                               "title": "Storage-lock agents widget render reproduction", "env": {"TERM": "xterm-256color"}}) + "\n")
        for event in events:
            cast.write(json.dumps(event) + "\n")
    (out / "checkpoints.json").write_text(json.dumps(checkpoints, indent=2) + "\n")
    (out / "result.json").write_text(json.dumps({"completedInteraction": completed, "failure": failure,
        "parentSessionId": parent_id, "exitCode": os.waitstatus_to_exitcode(exit_status) if exit_status is not None else None,
        "diedDuringLock": died, "cleanup": cleanup, "interactive": True,
        "terminal": "owned POSIX PTY", "humanReview": "not performed"}, indent=2) + "\n")
if failure:
    print(failure)
    raise SystemExit(1)
