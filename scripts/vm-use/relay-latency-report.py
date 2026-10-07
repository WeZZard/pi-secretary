"""Report for a relay-latency.ts output directory. All times are this Mac's clock unless named guest.

    python3 scripts/vm-use/relay-latency-report.py test-results/vm-use/relay-latency-<time>
"""
import glob, json, os, re, statistics, sys
from collections import Counter, defaultdict

out = sys.argv[1]
load = lambda name: [json.loads(line) for line in open(os.path.join(out, name))] if os.path.exists(os.path.join(out, name)) else []
requests = [r for r in load('requests.jsonl') if 'kind' in r]
for r in requests:
    if re.fullmatch(r'/vms/[^/]+', r['path']): r['kind'] = 'vm-status'
calls = load('calls.jsonl')
procs = load('processes.jsonl')
med = lambda values: round(statistics.median(values)) if values else None
lines = []
say = lines.append

# Our VM's address, from vm-service's own answers.
ips = {r['vm'].get('ip') for r in requests if r.get('vm') and r['vm'].get('ip')} | {r['vm'].get('name') for r in requests if r.get('vm') and r['vm'].get('name')}
ssh = [p for p in procs if re.search(r'(^|/)(ssh|scp|sftp)\b', p['command'].split(' ')[0])]
ours = [p for p in ssh if any(ip and ip in p['command'] for ip in ips)]
say(f'Our VM (name and address): {sorted(ips)}; ssh-family processes under vm-service: {len(ssh)}, to our VM: {len(ours)}, to other VMs: {len(ssh) - len(ours)}')

# 1. What each call is made of.
say('\n## 1. Each client call: duration and the vm-service requests inside it (ms)')
by_phase = defaultdict(list)
for c in calls:
    inside = [r for r in requests if r['receivedAt'] >= c['startedAt'] and r['receivedAt'] < c['endedAt']]
    kinds = Counter(r['kind'] for r in inside)
    rec = [r for r in inside if r['kind'] == 'receiver']
    first_receiver = rec[0]['receivedAt'] if rec else None
    last_receiver_end = rec[-1]['endedAt'] if rec else None
    by_phase[c['phase']].append({
        'ms': c['endedAt'] - c['startedAt'],
        'before': (first_receiver - c['startedAt']) if rec else None,
        'receiver': sum(r['ms'] for r in rec) if rec else None,
        'after': (c['endedAt'] - last_receiver_end) if rec else None,
        'kinds': kinds, 'n': len(inside), 'ok': c['ok']})
for phase, items in by_phase.items():
    ok = [i for i in items if i['ok']]
    say(f"- phase {phase}: {len(ok)}/{len(items)} ok; call median {med([i['ms'] for i in ok])}; "
        f"before the receiver {med([i['before'] for i in ok if i['before'] is not None])}; "
        f"receiver request {med([i['receiver'] for i in ok if i['receiver'] is not None])}; "
        f"after the receiver {med([i['after'] for i in ok if i['after'] is not None])}; "
        f"requests per call median {med([i['n'] for i in ok])}; kinds in the first ok call {dict(ok[0]['kinds']) if ok else {}}")

# 2. Each kind of request, alone and with another of our requests running.
say('\n## 2. vm-service requests by kind (ms): alone vs overlapping another of our requests')
def overlaps(r):
    return any(o is not r and o['receivedAt'] < r['endedAt'] and o['endedAt'] > r['receivedAt'] for o in requests)
table = defaultdict(lambda: {'alone': [], 'overlapping': []})
for r in requests:
    table[r['kind']]['overlapping' if overlaps(r) else 'alone'].append(r['ms'])
for kind, t in sorted(table.items(), key=lambda kv: -len(kv[1]['alone']) - len(kv[1]['overlapping'])):
    say(f"- {kind}: alone n={len(t['alone'])} median {med(t['alone'])}; overlapping n={len(t['overlapping'])} median {med(t['overlapping'])}")

# 3. Does vm-service run two of our requests at the same time? Count our ssh processes alive together.
say('\n## 3. Concurrency inside vm-service')
events = sorted([(p['firstSeen'], 1) for p in ours] + [(p['lastSeen'], -1) for p in ours])
alive = peak = 0
for _, step in events:
    alive += step; peak = max(peak, alive)
say(f'- most ssh processes to our VM seen alive at once: {peak}')
pairs = [(a, b) for a in requests for b in requests if a['id'] < b['id'] and a['receivedAt'] < b['endedAt'] and b['receivedAt'] < a['endedAt']]
say(f'- pairs of our requests in flight at the same time: {len(pairs)}')
starts = []
for a, b in pairs:
    # The ssh process that served b: the first of ours seen after b arrived.
    after = [p for p in ours if p['firstSeen'] >= b['receivedAt'] - 50 and p['firstSeen'] <= b['endedAt']]
    if after: starts.append(min(p['firstSeen'] for p in after) - b['receivedAt'])
say(f'- for the later request of each overlapping pair, ms from arrival to its first ssh process: median {med(starts)} (n={len(starts)})')

# 4. ssh per request, and its options.
say('\n## 4. ssh processes')
per_exec = []
for r in requests:
    if r['path'].endswith(('/exec', '/push', '/pull')):
        per_exec.append(sum(1 for p in ours if p['firstSeen'] >= r['receivedAt'] - 50 and p['firstSeen'] <= r['endedAt']))
say(f'- ssh-family processes started per exec/push/pull request: {Counter(per_exec).most_common()}')
options = Counter(o for p in ours for o in re.findall(r'-o\s*(\w+)=', p['command']))
say(f'- ssh -o options used: {dict(options)}')
say(f"- control socket options present: {any(re.search(r'Control(Master|Path|Persist)', p['command']) for p in ours)}")
if ours: say(f"- example command (first 300 chars): {ours[0]['command'][:300]}")
life = [p['lastSeen'] - p['firstSeen'] for p in ours]
say(f'- ssh process lifetime as sampled (resolution about the sampling period): median {med(life)} ms')

# 5. Guest time inside each receiver request, from the guest journal (durations only, no cross-clock comparison).
say('\n## 5. Receiver request vs guest time (ms)')
journal = glob.glob(os.path.join(out, 'relay-evidence', '*', 'state', 'journal', 'events.jsonl'))
if journal:
    from datetime import datetime
    t = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000
    ev = [json.loads(l) for l in open(journal[0])]
    route = {e['executionId']: t(e['writtenAt']) for e in ev if e.get('annotationType') == 'routing-decision'}
    done = {e['executionId']: t(e['writtenAt']) for e in ev if e.get('kind') == 'execution-completion'}
    guest = [done[k] - route[k] for k in route if k in done]
    rec = [r['ms'] for r in requests if r['kind'] == 'receiver']
    say(f'- guest routing-decision to execution-completion: median {med(guest)} (n={len(guest)})')
    say(f'- receiver request on the Mac: median {med(rec)} (n={len(rec)}); the difference is ssh, two node starts and the receiver before routing and after completion')
else:
    say('- no evidence package found')
open(os.path.join(out, 'report.md'), 'w').write('\n'.join(lines) + '\n')
print('\n'.join(lines))

# 6. Serial or parallel: for each request that arrived while another of ours was running, compare
# how long it took after it could first run in parallel (its arrival) and after the other one ended.
say('\n## 6. Overlapping short requests: does the later one wait for the earlier one?')
short = [r for r in requests if r['path'].endswith(('/exec', '/push', '/pull')) and r['kind'] != 'receiver' and r['ms'] < 2000]
waits, own = [], []
for b in short:
    earlier = [a for a in short if a is not b and a['receivedAt'] < b['receivedAt'] < a['endedAt']]
    if not earlier: continue
    a_end = max(a['endedAt'] for a in earlier)
    own.append(b['ms'])
    waits.append(b['endedAt'] - a_end)
alone = [r['ms'] for r in short if not any(o is not r and o['receivedAt'] < r['endedAt'] and o['endedAt'] > r['receivedAt'] for o in short)]
say(f'- short requests alone: median {med(alone)} ms (n={len(alone)})')
say(f'- later request of an overlapping pair: total median {med(own)} ms; from the earlier one\'s end to its own end median {med(waits)} ms (n={len(waits)})')
say(f'- later request ended before the earlier one: {sum(w < 0 for w in waits)} of {len(waits)}')
open(os.path.join(out, 'report.md'), 'w').write('\n'.join(lines) + '\n')
print('\n'.join(lines[-4:]))
