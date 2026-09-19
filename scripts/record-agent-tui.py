#!/usr/bin/env python3
"""Record an isolated real pi TUI through a pseudo-terminal, without opening a GUI."""
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
    "recorder": "scripts/record-agent-tui.py", "createdAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "fixture": "tests/support/agent-tui-extension.ts"}, indent=2) + "\n")
root = pathlib.Path(tempfile.mkdtemp(prefix="secretary-tui-recording-"))
agentdir = root / "agent"
agentdir.mkdir()
(agentdir / "settings.json").write_text(json.dumps({"compaction": {"enabled": False}, "retry": {"enabled": False}, "quietStartup": True}))
(root / "facts.txt").write_text("Deterministic terminal acceptance fixture.\n")
columns, rows = 110, 34
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
                "--extension", str(repo / "tests/support/agent-tui-extension.ts"),
                "--model", "secretary-tui-test/fixture", "--thinking", "off", "--tui-mode", "regular"]
        os.execvpe(argv[0], argv, env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    wait_for(lambda: (root / "parent-ready").exists(), "parent fixture initialization")
    # Wait until the editor has painted before submitting the initial task.
    expect("fixture")
    start = len(raw)
    send("Launch the acceptance worker.\r")
    wait_for(lambda: (root / "child-running").exists(), "controlled child execution")
    expect("delegated execution is visible", start)
    checkpoint("01-running-fleet")
    start = len(raw)
    send("\x1b[B")
    expect("main", start)
    send("\x1b[B\r")
    expect("Task:", start)
    checkpoint("02-wide-inspector")
    start = len(raw)
    send("\x1b[5~")
    expect("Transcript: paused", start)
    checkpoint("02b-paused-transcript")
    start = len(raw)
    send("x")
    expect("Original prompt:", start)
    checkpoint("02c-expanded-tool-details")
    start = len(raw)
    send("\x1b[6~" * 20)
    expect("Transcript: following", start)
    checkpoint("02d-following-restored")
    start = len(raw)
    send("s")
    expect("guidance", start)
    send("Check failure handling before finishing.")
    expect("Check failure handling", start)
    checkpoint("03-message-composer")
    start = len(raw)
    send("\x1b")
    expect("Task:", start)
    start = len(raw)
    send("s")
    expect("Check failure handling", start)
    checkpoint("03b-retained-composer-draft")
    start = len(raw)
    send("\r")
    expect("acceptance is recorded", start)
    checkpoint("04-message-acknowledged")
    start = len(raw)
    resize(58, 22)
    expect("Task:", start)
    checkpoint("05-narrow-inspector")
    start = len(raw)
    send("D")
    expect("Confirm stop", start)
    checkpoint("06-stop-confirmation")
    start = len(raw)
    send("\r")
    wait_for(lambda: (root / "child-cancelled").exists(), "child cancellation")
    expect("acceptance-worker · cancelled", start)
    checkpoint("07-cancelled-inspector")
    start = len(raw)
    send("\x1b")
    wait_for(lambda: (root / "ui-closed").exists(), "inspector closure before further typing")
    # Secretary configuration menu walkthrough (interaction design §2.5). The editor is
    # empty here; resize back to a wide layout so status lines are not clipped.
    (root / "ui-closed").unlink()
    resize(110, 34)
    start = len(raw)
    send("/secretary\r")
    expect("Subagents", start)
    checkpoint("07b-menu-top")
    start = len(raw)
    send("\r")
    expect("Model Fallback Lists", start)
    checkpoint("07c-menu-manager")
    start = len(raw)
    send("a")
    expect("Name the fallback list.", start)
    send("acceptance-fallback")
    expect("acceptance-fallback", start)
    checkpoint("07d-menu-name-prompt")
    start = len(raw)
    send("\r")
    expect("Added list acceptance-fallback", start)
    checkpoint("07e-menu-list-added")
    start = len(raw)
    send("\r")
    expect("Models are tried from first to last.", start)
    checkpoint("07f-menu-list-detail")
    start = len(raw)
    send("\r")
    expect("Add Model › acceptance-fallback", start)
    # The picker lists the session's full model catalog; filter down to the fixture model.
    send("secretary-tui-test")
    expect("fixture [secretary-tui-test]", start)
    checkpoint("07g-menu-model-picker")
    start = len(raw)
    send("\r")
    expect("Added secretary-tui-test/fixture to acceptance-fallback", start)
    checkpoint("07h-menu-model-added")
    start = len(raw)
    send("\x1b")
    wait_for(lambda: (root / "ui-closed").exists(), "menu dismissal before further typing")
    send("Preserved editor draft")
    expect("Preserved editor draft", start)
    checkpoint("08-editor-return")
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
        cast.write(json.dumps({"version": 2, "width": 110, "height": 34, "title": "Secretary isolated TUI acceptance", "env": {"TERM": "xterm-256color"}}) + "\n")
        for event in events:
            cast.write(json.dumps(event) + "\n")
    (out / "checkpoints.json").write_text(json.dumps(checkpoints, indent=2) + "\n")
    (out / "result.json").write_text(json.dumps({"completed": success, "checkpoints": len(checkpoints), "liveProviderRequests": False, "humanReview": "not performed"}, indent=2) + "\n")
    shutil.rmtree(root, ignore_errors=True)
if success:
    print("Recorded isolated TUI walkthrough: " + str(out))
