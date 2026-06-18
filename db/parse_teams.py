#!/usr/bin/env python3
import json, sys

with open('/tmp/scoreboard_raw.txt') as f:
    content = f.read()

# Skip header lines
lines = content.split(chr(10))
json_line = None
for line in lines:
    line = line.strip()
    if line.startswith('{'):
        json_line = line
        break

if not json_line:
    print('No JSON found', file=sys.stderr)
    sys.exit(1)

d = json.loads(json_line)
teams = {}
for e in d.get('events', []):
    for comp in e.get('competitions', []):
        for ct in comp.get('competitors', []):
            t = ct.get('team', {})
            if t.get('id'):
                teams[t['id']] = t.get('displayName', '')
print(json.dumps(teams))
print('Total teams:', len(teams), file=sys.stderr)
