/**
 * espnSync.js — shared ESPN score sync logic
 * Called by the admin manual button AND the server auto-sync interval.
 */

const ESPN_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=20260611-20260719&limit=200';

const TEAM_MAP = {
  'Mexico': '🇲🇽 Mexico',
  'Czech Republic': '🇨🇿 Czechia', 'Czechia': '🇨🇿 Czechia',
  'South Korea': '🇰🇷 South Korea',
  'South Africa': '🇿🇦 South Africa',
  'Canada': '🇨🇦 Canada',
  'Switzerland': '🇨🇭 Switzerland',
  'Bosnia and Herzegovina': '🇧🇦 Bosnia & Herz.', 'Bosnia & Herzegovina': '🇧🇦 Bosnia & Herz.',
  'Qatar': '🇶🇦 Qatar',
  'Brazil': '🇧🇷 Brazil',
  'Scotland': '🏴󠁧󠁢󠁳󠁣󠁴󠁿 Scotland',
  'Morocco': '🇲🇦 Morocco',
  'Haiti': '🇭🇹 Haiti',
  'United States': '🇺🇸 USA', 'USA': '🇺🇸 USA',
  'Australia': '🇦🇺 Australia',
  'Turkey': '🇹🇷 Türkiye', 'Türkiye': '🇹🇷 Türkiye',
  'Paraguay': '🇵🇾 Paraguay',
  'Germany': '🇩🇪 Germany',
  "Ivory Coast": '🇨🇮 Ivory Coast', "Côte d'Ivoire": '🇨🇮 Ivory Coast',
  'Ecuador': '🇪🇨 Ecuador',
  'Curacao': '🇨🇼 Curaçao', 'Curaçao': '🇨🇼 Curaçao',
  'Netherlands': '🇳🇱 Netherlands',
  'Sweden': '🇸🇪 Sweden',
  'Japan': '🇯🇵 Japan',
  'Tunisia': '🇹🇳 Tunisia',
  'Belgium': '🇧🇪 Belgium',
  'Iran': '🇮🇷 Iran',
  'New Zealand': '🇳🇿 New Zealand',
  'Egypt': '🇪🇬 Egypt',
  'Spain': '🇪🇸 Spain',
  'Saudi Arabia': '🇸🇦 Saudi Arabia',
  'Uruguay': '🇺🇾 Uruguay',
  'Cape Verde': '🇨🇻 Cape Verde',
  'France': '🇫🇷 France',
  'Norway': '🇳🇴 Norway',
  'Senegal': '🇸🇳 Senegal',
  'Iraq': '🇮🇶 Iraq',
  'Argentina': '🇦🇷 Argentina',
  'Austria': '🇦🇹 Austria',
  'Jordan': '🇯🇴 Jordan',
  'Algeria': '🇩🇿 Algeria',
  'Portugal': '🇵🇹 Portugal',
  'Colombia': '🇨🇴 Colombia',
  'Uzbekistan': '🇺🇿 Uzbekistan',
  'DR Congo': '🇨🇩 DR Congo', 'Congo': '🇨🇩 DR Congo', 'Democratic Republic of the Congo': '🇨🇩 DR Congo',
  'England': '🏴󠁧󠁢󠁥󠁮󠁧󠁿 England',
  'Croatia': '🇭🇷 Croatia',
  'Ghana': '🇬🇭 Ghana',
  'Panama': '🇵🇦 Panama',
};

/**
 * Fetch completed scores from ESPN and upsert into the DB.
 * Returns { synced, skipped, error }.
 */
async function syncFromESPN(db) {
  let espnData;
  try {
    const resp = await fetch(ESPN_URL, { signal: AbortSignal.timeout(10000) });
    espnData = await resp.json();
  } catch (e) {
    return { synced: 0, skipped: 0, error: e.message };
  }

  const upsertResult = db.prepare(`
    INSERT INTO results (match_id, result, aet_result, score_a, score_b) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (match_id) DO UPDATE SET
      result=excluded.result, aet_result=excluded.aet_result,
      score_a=excluded.score_a, score_b=excluded.score_b,
      entered_at=CURRENT_TIMESTAMP
  `);

  const events = espnData.events || [];
  let synced = 0, skipped = 0, teamsUpdated = 0;

  // ── Pass 1: sync completed match results ─────────────────────────────────
  for (const event of events) {
    try {
      const comp = event.competitions?.[0];
      if (!comp) { skipped++; continue; }

      const statusType = comp.status?.type;
      if (!statusType?.completed) { skipped++; continue; }

      const competitors = comp.competitors || [];
      if (competitors.length !== 2) { skipped++; continue; }

      const home = competitors.find(c => c.homeAway === 'home');
      const away = competitors.find(c => c.homeAway === 'away');
      if (!home || !away) { skipped++; continue; }

      const map = n => TEAM_MAP[n];
      const homeTeam = map(home.team?.displayName) || map(home.team?.name) || map(home.team?.shortDisplayName);
      const awayTeam = map(away.team?.displayName) || map(away.team?.name) || map(away.team?.shortDisplayName);
      if (!homeTeam || !awayTeam) { skipped++; continue; }

      let match = db.prepare('SELECT * FROM matches WHERE team_a=? AND team_b=?').get(homeTeam, awayTeam);
      let flipped = false;
      if (!match) {
        match = db.prepare('SELECT * FROM matches WHERE team_a=? AND team_b=?').get(awayTeam, homeTeam);
        flipped = true;
      }
      if (!match) { skipped++; continue; }

      const homeScore = parseInt(home.score ?? 0);
      const awayScore = parseInt(away.score ?? 0);

      let result;
      if (!flipped) {
        result = homeScore > awayScore ? 'team_a' : homeScore < awayScore ? 'team_b' : 'draw';
      } else {
        result = awayScore > homeScore ? 'team_a' : awayScore < homeScore ? 'team_b' : 'draw';
      }

      const detail = (statusType.detail || statusType.shortDetail || '').toLowerCase();
      const isAET = /extra|aet|penalties|pen\b|pks/i.test(detail);
      const aetResult = match.is_knockout ? (isAET ? 'aet' : '90min') : null;

      const saVal = !flipped ? homeScore : awayScore;
      const sbVal = !flipped ? awayScore : homeScore;
      upsertResult.run(match.id, result, aetResult, saVal, sbVal);
      db.prepare('UPDATE matches SET is_locked=1 WHERE id=?').run(match.id);
      synced++;
    } catch (_) { skipped++; }
  }

  // ── Pass 2: update team names for upcoming knockout matches ───────────────
  for (const event of events) {
    try {
      const comp = event.competitions?.[0];
      if (!comp) continue;

      const statusType = comp.status?.type;
      if (statusType?.completed) continue; // already handled in pass 1

      const competitors = comp.competitors || [];
      if (competitors.length !== 2) continue;

      const home = competitors.find(c => c.homeAway === 'home');
      const away = competitors.find(c => c.homeAway === 'away');
      if (!home || !away) continue;

      const map = n => TEAM_MAP[n];
      const homeTeam = map(home.team?.displayName) || map(home.team?.name) || map(home.team?.shortDisplayName);
      const awayTeam = map(away.team?.displayName) || map(away.team?.name) || map(away.team?.shortDisplayName);
      if (!homeTeam || !awayTeam) continue; // TBD — teams not yet determined

      // If this exact pairing already exists in DB, nothing to update
      const exactMatch = db.prepare(
        'SELECT id FROM matches WHERE (team_a=? AND team_b=?) OR (team_a=? AND team_b=?)'
      ).get(homeTeam, awayTeam, awayTeam, homeTeam);
      if (exactMatch) continue;

      // Find the corresponding knockout match by time (±20 min window)
      const eventTime = new Date(event.date || comp.date);
      if (isNaN(eventTime.getTime())) continue;
      const tMin = new Date(eventTime.getTime() - 20 * 60 * 1000).toISOString();
      const tMax = new Date(eventTime.getTime() + 20 * 60 * 1000).toISOString();

      const match = db.prepare(
        `SELECT * FROM matches WHERE round != 'group' AND match_time BETWEEN ? AND ?`
      ).get(tMin, tMax);
      if (!match) continue;

      db.prepare('UPDATE matches SET team_a=?, team_b=? WHERE id=?').run(homeTeam, awayTeam, match.id);
      teamsUpdated++;
    } catch (_) {}
  }

  return { synced, skipped, teamsUpdated, error: null };
}

module.exports = { syncFromESPN };
