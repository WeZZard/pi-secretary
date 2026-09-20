#!/usr/bin/env python3
"""Run real Secretary inline tools in an isolated PTY, then assert the replayed grid.

Usage: python3 scripts/record-inline-tools.py [--output NEW_OR_EMPTY_DIRECTORY]
No desktop terminal or network provider is used. Ctrl+O is sent as keyboard input;
file gates control only the deterministic provider's completion, not tool rendering.
"""
import argparse
import codecs
import errno
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import shutil
import signal
import struct
import tempfile
import termios
import time
import subprocess
import sys
sys.dont_write_bytecode = True
from test_artifacts import reserve_recording_directory

parser = argparse.ArgumentParser()
parser.add_argument("--output", help="New or empty run directory. Defaults to test-results/tui/<UTC timestamp>-<id>.")
args = parser.parse_args()
repo = pathlib.Path(__file__).resolve().parent.parent
try:
    out = reserve_recording_directory(repo, args.output)
except ValueError as error:
    parser.error(str(error))
try:
    revision = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    dirty = bool(subprocess.check_output(["git", "-C", str(repo), "status", "--porcelain", "--untracked-files=normal"], text=True).strip())
except (OSError, subprocess.CalledProcessError):
    revision, dirty = None, None
(out / "run-metadata.json").write_text(json.dumps({"schemaVersion": 1, "revision": revision, "workingTreeDirty": dirty,
    "recorder": "scripts/record-inline-tools.py", "createdAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "fixture": "tests/support/inline-tui-extension.ts"}, indent=2) + "\n")
root = pathlib.Path(tempfile.mkdtemp(prefix="secretary-inline-"))
agentdir = root / "agent"
agentdir.mkdir()
(agentdir / "settings.json").write_text(json.dumps({"compaction": {"enabled": False}, "retry": {"enabled": False}, "quietStartup": True}))
columns, rows = 110, 60
events = []
checkpoints = []
started = time.monotonic()
raw = ""
query_tail = ""
decoder = codecs.getincrementaldecoder("utf-8")("replace")
child = None
fd = None
success = False

def now():
    return round(time.monotonic() - started, 6)

def send(data, record=True):
    if record:
        events.append([now(), "i", data])
    os.write(fd, data.encode())

def pump(timeout=0.05):
    global raw, query_tail
    ready, _, _ = select.select([fd], [], [], timeout)
    if not ready:
        return
    try:
        data = os.read(fd, 65536)
    except OSError as error:
        if error.errno == errno.EIO:
            raise RuntimeError("pi exited before the walkthrough completed") from error
        raise
    if not data:
        raise RuntimeError("pi closed the terminal")
    text = decoder.decode(data)
    events.append([now(), "o", text])
    raw += text
    combined = query_tail + text
    # Respond to terminal capability queries without injecting keys into the application.
    if "\x1b[6n" in combined:
        send("\x1b[1;1R", False)
    if "\x1b[c" in combined or "\x1b[0c" in combined:
        send("\x1b[?1;2c", False)
    if "\x1b[?u" in combined:
        send("\x1b[?0u", False)
    query_tail = combined[-3:]

def plain(text):
    return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)

def wait_for(predicate, label, timeout=20):
    until = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= until:
            raise RuntimeError("Timed out waiting for " + label + "\n" + plain(raw[-8000:]))
        pump()

def expect(text, start=0):
    wait_for(lambda: text in plain(raw[start:]), repr(text))

def checkpoint(label):
    # Pi brackets each terminal repaint with synchronized-output markers. Capture only
    # a complete repaint, rather than a partial PTY read that already contains a label.
    wait_for(lambda: raw.count("\x1b[?2026h") == raw.count("\x1b[?2026l"), "complete terminal repaint")
    checkpoints.append({"name": label, "eventIndex": len(events), "columns": columns, "rows": rows, "time": now()})

def resize(cols, lines):
    global columns, rows
    columns, rows = cols, lines
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    os.kill(child, signal.SIGWINCH)
    events.append([now(), "r", f"{columns}x{rows}"])

try:
    child, fd = pty.fork()
    if child == 0:
        os.chdir(root)
        env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor", PI_OFFLINE="1",
                   PI_CODING_AGENT_DIR=str(agentdir), PI_SECRETARY_DB_DIR=str(root / "state"),
                   SECRETARY_TUI_FIXTURE=str(root), NO_COLOR="")
        argv = [shutil.which("node"), str(repo / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
                "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
                "--extension", str(repo / "tests/support/inline-tui-extension.ts"),
                "--model", "inline-test/fixture", "--thinking", "off", "--tui-mode", "regular"]
        os.execvpe(argv[0], argv, env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    wait_for(lambda: (root / "parent-ready").exists(), "parent fixture initialization")
    expect("fixture")
    start = len(raw)
    send("foreground\r")
    wait_for(lambda: (root / "foreground-running").exists(), "foreground provider gate")
    expect("expand for task details", start)
    checkpoint("01-foreground-compact")
    start = len(raw)
    send("\x0f")
    expect("FOREGROUND_TASK", start)
    checkpoint("02-foreground-full")
    start = len(raw)
    send("\x0f")
    expect("expand for task details", start)
    checkpoint("03-foreground-recollapsed")
    start = len(raw)
    (root / "release-foreground").write_text("release")
    expect("INLINE_STEP_DONE", start)
    checkpoint("04-foreground-completed")
    start = len(raw)
    send("\x0f")
    expect("FOREGROUND_RESULT", start)
    checkpoint("05-completed-full")
    send("\x0f")
    start = len(raw)
    send("background\r")
    wait_for(lambda: (root / "background-running").exists(), "background provider gate")
    expect("INLINE_STEP_DONE", start)
    checkpoint("06-background-launch")
    start = len(raw)
    send("message\r")
    expect("Message: MESSAGE_FIRST", start)
    expect("INLINE_STEP_DONE", start)
    checkpoint("07-message-compact")
    start = len(raw)
    send("\x0f")
    expect("MESSAGE_SECOND", start)
    checkpoint("08-message-full")
    start = len(raw)
    resize(58, 60)
    expect("MESSAGE_SECOND", start)
    checkpoint("09-narrow-full")
    start = len(raw)
    send("\x0f")
    expect("Message: MESSAGE_FIRST", start)
    checkpoint("10-narrow-compact")
    start = len(raw)
    resize(110, 60)
    expect("Message: MESSAGE_FIRST", start)
    checkpoint("11-wide-compact")
    success = True
finally:
    if child and child > 0:
        try:
            os.kill(child, signal.SIGTERM)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                if os.waitpid(child, os.WNOHANG)[0]:
                    break
                try:
                    pump()
                except RuntimeError:
                    break
            else:
                os.kill(child, signal.SIGKILL)
            try:
                os.waitpid(child, 0)
            except ChildProcessError:
                pass
        except ProcessLookupError:
            pass
    if fd is not None:
        os.close(fd)
    with (out / "walkthrough.cast").open("w") as cast:
        cast.write(json.dumps({"version": 2, "width": 110, "height": 60, "title": "Secretary inline Agent and SendMessage walkthrough", "env": {"TERM": "xterm-256color"}}) + "\n")
        for event in events:
            cast.write(json.dumps(event) + "\n")
    (out / "checkpoints.json").write_text(json.dumps(checkpoints, indent=2) + "\n")
    (out / "result.json").write_text(json.dumps({"completed": success, "gridVerified": False, "checkpoints": len(checkpoints), "liveProviderRequests": False, "humanReview": "not performed"}, indent=2) + "\n")
    shutil.copytree(root, out / "fixture-state")
    shutil.rmtree(root, ignore_errors=True)
if success:
    verification = subprocess.run([shutil.which("node"), "--experimental-strip-types", str(repo / "scripts/check-inline-recording.ts"), str(out)], capture_output=True, text=True)
    (out / "grid-verification.log").write_text(verification.stdout + verification.stderr)
    result = json.loads((out / "result.json").read_text())
    result["gridVerified"] = verification.returncode == 0
    (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(verification.stdout, end="")
    print("Recorded isolated TUI walkthrough: " + str(out))
    if verification.returncode:
        print(verification.stderr, file=sys.stderr)
        sys.exit(verification.returncode)
