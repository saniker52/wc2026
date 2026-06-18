#!/usr/bin/env python3
"""Fetch all WC2026 rosters from ESPN API and generate wc2026-players.js"""

import urllib.request
import json
import ssl
import time
import os

TEAMS = {
    "Algeria": 624,
    "Argentina": 202,
    "Australia": 628,
    "Austria": 474,
    "Belgium": 459,
    "Bosnia-Herzegovina": 452,
    "Brazil": 205,
    "Canada": 206,
    "Cape Verde": 2597,
    "Colombia": 208,
    "Congo DR": 2850,
    "Croatia": 477,
    "Curaçao": 11678,
    "Czechia": 450,
    "Ecuador": 209,
    "Egypt": 2620,
    "England": 448,
    "France": 478,
    "Germany": 481,
    "Ghana": 4469,
    "Haiti": 2654,
    "Iran": 469,
    "Iraq": 4375,
    "Ivory Coast": 4789,
    "Japan": 627,
    "Jordan": 2917,
    "Mexico": 203,
    "Morocco": 2869,
    "Netherlands": 449,
    "New Zealand": 2666,
    "Norway": 464,
    "Panama": 2659,
    "Paraguay": 210,
    "Portugal": 482,
    "Qatar": 4398,
    "Saudi Arabia": 655,
    "Scotland": 580,
    "Senegal": 654,
    "South Africa": 467,
    "South Korea": 451,
    "Spain": 164,
    "Sweden": 466,
    "Switzerland": 475,
    "Tunisia": 659,
    "Türkiye": 465,
    "United States": 660,
    "Uruguay": 212,
    "Uzbekistan": 2570,
}

POS_MAP = {
    "G": "GK", "GK": "GK",
    "D": "DF", "CB": "DF", "LB": "DF", "RB": "DF", "LWB": "DF", "RWB": "DF", "SW": "DF",
    "M": "MF", "CM": "MF", "LM": "MF", "RM": "MF", "DM": "MF", "AM": "MF", "CDM": "MF", "CAM": "MF",
    "F": "FW", "FW": "FW", "ST": "FW", "LW": "FW", "RW": "FW", "CF": "FW", "SS": "FW",
}

POS_ORDER = {"GK": 0, "DF": 1, "MF": 2, "FW": 3}

ctx = ssl.create_default_context()

def fetch_roster(team_name, team_id):
    url = f"https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/teams/{team_id}/roster"
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json",
    }
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=20) as r:
            data = json.load(r)
        return data
    except Exception as e:
        print(f"  ERROR fetching {team_name}: {e}")
        return None

def map_pos(abbr):
    if not abbr:
        return "MF"
    return POS_MAP.get(abbr.upper(), "MF")

def parse_dob(dob_str):
    if not dob_str:
        return ""
    return dob_str[:10]  # "1990-01-15T00:00Z" -> "1990-01-15"

all_players = []
failed_teams = []

for team_name, team_id in TEAMS.items():
    print(f"Fetching {team_name} ({team_id})...")
    data = fetch_roster(team_name, team_id)
    if not data:
        failed_teams.append(team_name)
        continue

    espn_name = data.get("team", {}).get("displayName", team_name)
    athletes = data.get("athletes", [])
    print(f"  -> {espn_name}: {len(athletes)} players")

    team_players = []
    seen_names = set()
    for a in athletes:
        name = a.get("displayName", "").strip()
        if not name or name in seen_names:
            continue
        seen_names.add(name)
        pos_abbr = a.get("position", {}).get("abbreviation", "")
        pos = map_pos(pos_abbr)
        dob = parse_dob(a.get("dateOfBirth", ""))
        team_players.append({"name": name, "country": espn_name, "position": pos, "dob": dob})

    # Sort: GK, DF, MF, FW
    team_players.sort(key=lambda p: POS_ORDER.get(p["position"], 2))
    all_players.extend(team_players)
    time.sleep(0.3)

print(f"\nTotal players: {len(all_players)}")
if failed_teams:
    print(f"Failed teams: {failed_teams}")

# Generate JS
lines = ['// Auto-generated from ESPN API — FIFA World Cup 2026 official squads']
lines.append('// Fields: name, country, position (GK/DF/MF/FW), dob (YYYY-MM-DD)')
lines.append('const WC2026_PLAYERS = [')

for p in all_players:
    name_esc = p["name"].replace("\\", "\\\\").replace('"', '\\"')
    country_esc = p["country"].replace("\\", "\\\\").replace('"', '\\"')
    lines.append(f'  {{ name: "{name_esc}", country: "{country_esc}", position: "{p["position"]}", dob: "{p["dob"]}" }},')

lines.append('];')
lines.append('')
lines.append('module.exports = WC2026_PLAYERS;')

out_path = os.path.join(os.path.dirname(__file__), "db", "wc2026-players.js")
os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")

print(f"\nWritten to: {out_path}")
