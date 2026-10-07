"""What each step interval of a traced vm-use run is made of.

    python3 scripts/vm-use/step-interval-report.py <run-dir> <trajectory.json> [out-dir]

<run-dir> is a Pi run under test-results/e2e/ recorded with PI_SECRETARY_VM_USE_TRACE (macarena-run.ts --trace):
trace/spans.jsonl (Pi's own work), trace/vm-service.jsonl (every request the relay server sent to vm-service)
and relay-evidence/<package>/ (the relay's journal and action records, written in the VM). <trajectory.json> is the
trajectory viewer's data for the run (GET /.api/<agent>.json), whose step intervals are the ones explained.

An interval is the viewer's: from where the earlier step's time ends (its after-screenshot, on the VM's clock) to the
start of the next step's action (VM clock). Every instant of it is given one ingredient, the first that applies:
  1. VM: work inside the relay receiver, from the journal and action records (mapped to the Mac's clock);
  2. a vm-service request the relay server is waiting on for this step, split into the part spent queued behind
     another request and the part served (vm-service serves one request at a time: the earlier latency report, F6);
  3. the relay server's own processing inside a relay tool call (no request of its own in flight);
  4. Pi's own work: the innermost traced span (settle wait, grounder request, observer, records, ...);
  5. Pi outside any traced span.
The VM's clock is mapped to the Mac's from the receiver requests: each one, on the Mac, contains its execution's
journal from routing decision to completion, which bounds the offset (Cristian's algorithm, taking the tightest bounds
over all executions).
Output: report.md, intervals.jsonl, trace.json (Chrome Trace Event Format, for https://ui.perfetto.dev) and
timeline.html, in out-dir (default <run-dir>/trace/report).
"""
import glob, html, json, os, re, statistics, sys
from collections import Counter, defaultdict
from datetime import datetime

run, trajectory_file = sys.argv[1], sys.argv[2]
out = sys.argv[3] if len(sys.argv) > 3 else os.path.join(run, 'trace', 'report')
os.makedirs(out, exist_ok=True)
t = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000 if s else None
jsonl = lambda path: [json.loads(line) for line in open(path) if line.strip()]
med = lambda values: round(statistics.median(values)) if values else None

spans = [s for s in jsonl(os.path.join(run, 'trace', 'spans.jsonl')) if s['name'] != 'vm-service proxy']
requests = [r for r in jsonl(os.path.join(run, 'trace', 'vm-service.jsonl')) if 'end' in r]
requests.sort(key=lambda r: r['start'])
packages = [p for p in glob.glob(os.path.join(run, 'relay-evidence', '*')) if os.path.isdir(os.path.join(p, 'state'))]

# Request kinds, by text unique to each guest script of mcp-vm-relay 0.9.0 (dist/server.mjs 19643-19660, 20127).
MARKERS = [('receiver', 'spawnSync(process.execPath,[receiver'), ('image-fact', 'Source changed before image hash'),
           ('prepare', 'check(root,target,true);fs.mkdirSync'), ('scan', 'walk(root);check(approved,root);check(frameRoot'),
           ('file-fact', 'Invalid frame file'), ('size', 'bytes+=s.size;files++'), ('remove-frame', 'fs.rmSync(file,{force:true})'),
           ('guest-path', 'check(process.argv[1],process.argv[2]);')]
def script(part):
    if isinstance(part, str) and part.startswith('sha256:'):
        path = os.path.join(run, 'trace', 'scripts', part[7:] + '.txt')
        return open(path).read() if os.path.exists(path) else ''
    return str(part)
for r in requests:
    action = r['path'].split('/')[-1]
    if re.fullmatch(r'/vms/[^/]+', r['path']): r['kind'] = 'vm-status'
    elif action != 'exec': r['kind'] = action
    else:
        text = ' '.join(script(p) for p in (r.get('body') or {}).get('argv', []))
        r['kind'] = next((kind for kind, marker in MARKERS if marker in text), 'exec')
    body = r.get('body') or {}
    r['file'] = body.get('remote_path', '')
    m = re.search(r'(execution-[0-9a-z]+)', json.dumps(body))
    r['execution'] = m.group(1) if m else None

# vm-service runs one command or copy (exec, push, pull) at a time; the check below confirms it for this run. Each
# one's service starts when it arrived or when the one before it ended, whichever is later; until then it waited
# behind that one. Status and heartbeat requests are answered outside that queue.
QUEUED = ('exec', 'push', 'pull')
queued = lambda r: r['path'].split('/')[-1] in QUEUED
served_until, previous = -1e18, None
for r in requests:
    if not queued(r): r['serviceStart'], r['behind'] = r['start'], None; continue
    r['serviceStart'] = max(r['start'], served_until)
    r['behind'] = previous if r['serviceStart'] > r['start'] else None
    if r['end'] >= served_until: served_until, previous = r['end'], r

# The relay's background download of each step's after-screenshot (host/image-downloads), on the Mac's clock.
downloads = []
for p in packages:
    for f in glob.glob(os.path.join(p, 'host', 'image-downloads', '*.json')):
        d = json.load(open(f)); m = re.search(r'(execution-[0-9a-z]+)', os.path.basename(f))
        if m and d.get('startedAt'): downloads.append({'execution': m.group(1), 'start': t(d['startedAt']), 'end': t(d.get('endedAt')) or t(d['startedAt'])})
DOWNLOAD_FILES = re.compile(r'/state/(snapshots|records/action)/')
for r in requests:
    r['download'] = any(d['start'] - 5 <= r['start'] <= d['end'] + 5 for d in downloads) and (r['kind'] in ('image-fact', 'vm-status') or bool(DOWNLOAD_FILES.search(r['file'])))

# A relay tool call starts by checking its lease (reconcile): its first request, a vm-status, is its own.
for call in (s for s in spans if s['name'] == 'relay tool call'):
    first = next((r for r in requests if r['start'] >= call['start']), None)
    if first and first['kind'] == 'vm-status' and first['start'] < call['end']: first['download'] = False

# The serving order the split above assumes: a request that arrives while another is in flight ends after it.
commands = [r for r in requests if queued(r)]
overlapping = [(a, b) for i, a in enumerate(commands) for b in commands[i + 1:i + 4] if b['start'] < a['end']]
ended_first = sum(1 for a, b in overlapping if b['end'] < a['end'])
others = [r for r in requests if not queued(r)]
others_inside = sum(1 for o in others if any(c['start'] < o['start'] and o['end'] < c['end'] for c in commands))

# The receiver request of each execution: the one after the push of that execution's request file.
receiver_of = {}
last_pushed = None
for r in requests:
    if r['kind'] == 'push' and r['execution']: last_pushed = r['execution']
    if r['kind'] == 'receiver' and last_pushed: receiver_of[last_pushed] = r; last_pushed = None

# The VM's records: journal events and action records, on the VM's clock.
vm = defaultdict(dict)
for p in packages:
    for e in jsonl(os.path.join(p, 'state', 'journal', 'events.jsonl')):
        x = e.get('executionId')
        if not x: continue
        key = e.get('annotationType') or e.get('kind')
        vm[x].setdefault(key, t(e['writtenAt']))
    for f in glob.glob(os.path.join(p, 'state', 'records', 'action', '*.json')):
        a = json.load(open(f)); x = a.get('executionId')
        if not x: continue
        for s in a.get('snapshots', []):
            started, done = s.get('captureStartedAtMonotonic'), s.get('captureCompletedAtMonotonic')
            vm[x][f"{s['role']}-capture"] = (t(s['capturedAt']), t(s['capturedAt']) + (done - started) if started and done else None)

# Clock offset (VM minus Mac): routing decision - receiver start >= offset >= completion - receiver end.
upper = [vm[x]['routing-decision'] - r['start'] for x, r in receiver_of.items() if 'routing-decision' in vm[x]]
lower = [vm[x]['execution-completion'] - r['end'] for x, r in receiver_of.items() if 'execution-completion' in vm[x]]
low, high = max(lower), min(upper)
offset = (low + high) / 2
offset_error = (high - low) / 2
mac = lambda vm_ms: vm_ms - offset

traj = json.load(open(trajectory_file))
steps, details = traj['steps'], traj['details']
by_id = {s['id']: s for s in steps}
def execution_of(step):
    m = re.search(r'(execution-[0-9a-z]+)', json.dumps(details.get(step['id'], {}).get('argv', [])) + (step.get('observed') or ''))
    return m.group(1) if m else None

def ingredient(at, ex_before, ex_after):
    """The one ingredient of the instant `at` (Mac clock) in the interval from execution ex_before to ex_after."""
    for x, segments in ((ex_before, (('after-capture', 'VM: after-screenshot capture of the earlier step'), ('finish', 'VM: receiver records the earlier step and exits its journal'))),
                        (ex_after, (('admit', 'VM: receiver admits the next step (journal, before its action starts)'),))):
        if not x: continue
        v = vm[x]
        cap = v.get('after-capture')
        bounds = {'after-capture': (cap[0], cap[1]) if cap and cap[1] else None,
                  'finish': (cap[1] if cap and cap[1] else v.get('action-completion'), v.get('execution-completion')),
                  'admit': (v.get('routing-decision'), v.get('action-start'))}
        for name, label in segments:
            b = bounds[name]
            if b and b[0] is not None and b[1] is not None and mac(b[0]) <= at < mac(b[1]): return label
    own = [r for r in requests if r['start'] <= at < r['end'] and not r['download']]
    if own:
        r = min(own, key=lambda r: r['start'])
        if r['kind'] == 'receiver': return 'vm-service: receiver request outside the receiver journal (ssh, node start and exit in the VM)'
        if at < r['serviceStart'] and r['behind'] is not None:
            b = r['behind']
            return f"vm-service: queued behind {'the background screenshot download' if b['download'] else 'another request'}"
        return f"vm-service: {r['kind']} request"
    calls = [s for s in spans if s['name'] == 'relay tool call' and s['start'] <= at < s['end']]
    if calls:
        downloading = [r for r in requests if r['start'] <= at < r['end'] and r['download']]
        return 'relay server: own processing' + (' (download request in flight)' if downloading else '')
    inner = [s for s in spans if s['start'] <= at < s['end']]
    if inner:
        s = max(inner, key=lambda s: s['start'])
        return f"Pi: {s['name']}"
    return 'Pi: outside the vm-use tools (agent turn)'

def decompose(start, end, ex_before, ex_after):
    points = {start, end}
    for r in requests:
        for p in (r['start'], r['end'], r['serviceStart']):
            if start < p < end: points.add(p)
    for s in spans:
        for p in (s['start'], s['end']):
            if start < p < end: points.add(p)
    for x in (ex_before, ex_after):
        if not x: continue
        for value in vm[x].values():
            for p in (value if isinstance(value, tuple) else (value,)):
                if p is not None and start < mac(p) < end: points.add(mac(p))
    points = sorted(points)
    parts = Counter()
    pieces = []
    for a, b in zip(points, points[1:]):
        label = ingredient((a + b) / 2, ex_before, ex_after)
        parts[label] += b - a
        if pieces and pieces[-1][2] == label and abs(pieces[-1][1] - a) < 1e-6: pieces[-1][1] = b
        else: pieces.append([a, b, label])
    return parts, pieces

# The intervals: consecutive machine steps whose lead the viewer measured from the earlier step.
intervals, skipped = [], Counter()
for step in steps:
    d = details.get(step['id'], {}); lead = d.get('lead')
    if not step.get('machine'): continue
    if not lead: skipped['no interval in the viewer'] += 1; continue
    if not by_id.get(lead['from'], {}).get('machine'): skipped[f"interval measured from a {'plan' if by_id.get(lead['from'], {}).get('plan') else 'agent'} step"] += 1; continue
    earlier = by_id[lead['from']]
    ex_before, ex_after = execution_of(earlier), execution_of(step)
    if not (ex_before and ex_after and ex_before in receiver_of and ex_after in receiver_of): skipped['no relay execution found for a step'] += 1; continue
    end_vm = t(d['at']); start_vm = end_vm - lead['ms']
    parts, pieces = decompose(mac(start_vm), mac(end_vm), ex_before, ex_after)
    intervals.append({'from': earlier['id'], 'to': step['id'], 'fromTitle': earlier.get('title', ''), 'toTitle': step.get('title', ''),
                      'edge': lead['edge'], 'viewerMs': lead['ms'], 'parts': {k: round(v) for k, v in parts.items()},
                      'pieces': pieces, 'start': mac(start_vm), 'end': mac(end_vm)})

with open(os.path.join(out, 'intervals.jsonl'), 'w') as f:
    for i in intervals: f.write(json.dumps({k: v for k, v in i.items() if k != 'pieces'}) + '\n')

# The report.
lines = []; say = lines.append
say(f'# Step intervals of {os.path.basename(os.path.normpath(run))}\n')
say(f'- Sources: `trace/spans.jsonl` ({len(spans)} Pi spans), `trace/vm-service.jsonl` ({len(requests)} vm-service requests), '
    f'relay journal and action records ({len(vm)} executions), the viewer data `{os.path.basename(trajectory_file)}`.')
say(f'- VM clock minus Mac clock: {offset:.0f} ms, within ±{offset_error:.0f} ms (bounds from {len(upper)} receiver requests). '
    'Every VM time below is moved to the Mac clock by this offset, so a boundary between a VM ingredient and a Mac ingredient is uncertain by that much.')
say(f'- vm-service serving order: of {len(overlapping)} pairs of commands or copies (exec, push, pull) in flight together, the later one ended first in {ended_first}; '
    'such a request is counted as queued until the one before it ended. '
    f'Status and heartbeat requests are not queued: {others_inside} of {len(others)} began and ended while a command was running.')
say(f'- Intervals explained: {len(intervals)} (machine step to the next machine step, as the viewer measures them). Machine steps not explained: {dict(skipped)}.')
tags = lambda i: 'key to key (one typed text)' if 'press_key' in i['fromTitle'] and 'press_key' in i['toTitle'] and i['fromTitle'].split(' · ')[0] == i['toTitle'].split(' · ')[0] else 'other'
groups = defaultdict(list)
for i in intervals: groups[tags(i)].append(i); groups['all'].append(i)
for name in ('all', 'key to key (one typed text)', 'other'):
    g = groups.get(name)
    if not g: continue
    say(f'\n## {name}: {len(g)} intervals, viewer median {med([i["viewerMs"] for i in g])} ms\n')
    say('| Ingredient | median ms | mean ms | share of the total |')
    say('| --- | ---: | ---: | ---: |')
    labels = sorted({k for i in g for k in i['parts']}, key=lambda k: -sum(i['parts'].get(k, 0) for i in g))
    total = sum(sum(i['parts'].values()) for i in g)
    for k in labels:
        values = [i['parts'].get(k, 0) for i in g]
        say(f'| {k} | {med(values)} | {round(sum(values) / len(values))} | {100 * sum(values) / total:.1f}% |')
    say(f'| **viewer interval** | {med([i["viewerMs"] for i in g])} | {round(statistics.mean(i["viewerMs"] for i in g))} | |')

# One interval drawn out: the key-to-key interval with the median length.
keyed = sorted(groups.get('key to key (one typed text)') or intervals, key=lambda i: i['viewerMs'])
example = keyed[len(keyed) // 2] if keyed else None
if example:
    say(f'\n## One interval, in order: {example["from"]} → {example["to"]} ({round(example["viewerMs"])} ms in the viewer)\n')
    say('```')
    for a, b, label in example['pieces']:
        say(f'{a - example["start"]:7.0f} {b - example["start"]:7.0f} {b - a:6.0f}  {label}')
    say('```')
open(os.path.join(out, 'report.md'), 'w').write('\n'.join(lines) + '\n')
print('\n'.join(lines))

# Chrome Trace Event Format: Pi spans, relay tool calls, vm-service requests and VM work, one track each.
events, origin = [], min([s['start'] for s in spans] + [r['start'] for r in requests])
us = lambda ms: round((ms - origin) * 1000)
def complete(name, track, start, end, args=None):
    events.append({'name': name, 'ph': 'X', 'pid': 1, 'tid': track, 'ts': us(start), 'dur': max(1, round((end - start) * 1000)), 'args': args or {}})
TRACKS = {'Pi tools': 1, 'Pi executor': 2, 'Pi relay tool calls': 3, 'vm-service (this step)': 4, 'vm-service (background download)': 5, 'VM receiver (mapped)': 6, 'Viewer interval': 7}
for name, tid in TRACKS.items(): events.append({'name': 'thread_name', 'ph': 'M', 'pid': 1, 'tid': tid, 'args': {'name': name}})
for s in spans:
    track = 'Pi relay tool calls' if s['name'] == 'relay tool call' else 'Pi tools' if s['name'].startswith('tool ') else 'Pi executor'
    complete(s['name'] + (f" {s['args'].get('target') or s['args'].get('tool') or ''}" if s['name'] == 'relay tool call' else ''), TRACKS[track], s['start'], s['end'], s['args'])
for r in requests:
    complete(r['kind'], TRACKS['vm-service (background download)' if r['download'] else 'vm-service (this step)'], r['start'], r['end'],
             {'path': r['path'], 'file': r['file'], 'queuedMs': round(r['serviceStart'] - r['start'])})
for x, v in vm.items():
    if 'routing-decision' in v and 'execution-completion' in v:
        complete(f'receiver {x}', TRACKS['VM receiver (mapped)'], mac(v['routing-decision']), mac(v['execution-completion']))
for i in intervals: complete(f"{round(i['viewerMs'])} ms", TRACKS['Viewer interval'], i['start'], i['end'], {'from': i['from'], 'to': i['to']})
json.dump({'traceEvents': events, 'displayTimeUnit': 'ms'}, open(os.path.join(out, 'trace.json'), 'w'))

# A plain timeline of the example interval.
if example:
    colours = {}
    palette = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac', '#86bcb6', '#d37295']
    span_ms = example['end'] - example['start']
    rows = []
    for a, b, label in example['pieces']:
        colour = colours.setdefault(label, palette[len(colours) % len(palette)])
        rows.append(f'<div class="row"><span class="t">{a - example["start"]:.0f}–{b - example["start"]:.0f} ms</span><span class="bar"><i style="left:{100 * (a - example["start"]) / span_ms:.2f}%;width:{max(0.3, 100 * (b - a) / span_ms):.2f}%;background:{colour}"></i></span><span class="l">{html.escape(label)} · {b - a:.0f} ms</span></div>')
    page = f'''<!doctype html><meta charset="utf-8"><title>Step interval</title>
<style>body{{font:14px system-ui;margin:24px;max-width:1200px}}.row{{display:grid;grid-template-columns:110px 1fr 460px;gap:8px;align-items:center;margin:2px 0}}.bar{{position:relative;height:16px;background:#f2f2f2}}.bar i{{position:absolute;top:0;bottom:0}}.t{{color:#666;font-variant-numeric:tabular-nums}}</style>
<h1>One step interval: {html.escape(example["from"])} → {html.escape(example["to"])}</h1>
<p>{html.escape(example["fromTitle"])}<br>→ {html.escape(example["toTitle"])}</p>
<p>{span_ms:.0f} ms on the Mac clock; {example["viewerMs"]:.0f} ms in the viewer. VM times are moved to the Mac clock with an uncertainty of ±{offset_error:.0f} ms.</p>
{"".join(rows)}'''
    open(os.path.join(out, 'timeline.html'), 'w').write(page)
