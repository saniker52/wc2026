#!/usr/bin/env python3
import json, sys

src = '/var/folders/2_/gs793f8s6yzdxk0bvwlcm1580000gp/T/claude-hostloop-plugins/5d53b4cf541c804a/projects/-Users-Fawaz-Library-Application-Support-Claude-local-agent-mode-sessions-70f7265d-c31e-4715-ad9f-75c06da2434b-9692c536-93c8-4937-9b6f-4f1075a5b04e-local-bdd4fd1f-b80d-4601-bead-2ad243da085f-outputs/425a7afd-7e33-45c2-a803-980371d04757/tool-results/mcp-workspace-web_fetch-1781781094577.txt'

with open(src) as f:
    content = f.read()

lines = content.split('\n')
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

out = '/Users/Fawaz/Desktop/wc2026/db/teams.json'
with open(out, 'w') as f:
    json.dump(teams, f, ensure_ascii=False, indent=2)
print(f'Wrote {len(teams)} teams to {out}')
