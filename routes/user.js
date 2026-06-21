const express = require('express');
const { getDb, calculateMatchPoints, toKuwaitTime, toKuwaitTimeShort } = require('../db/database');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/dashboard', requireLogin, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const now = new Date().toISOString();

  // Helper: Kuwait date string (YYYY-MM-DD)
  function kwtDate(iso) {
    return new Date(new Date(iso).getTime() + 3*60*60*1000).toISOString().slice(0,10);
  }
  const todayKwt = kwtDate(now);

  // Absolute next upcoming match
  const nextMatch = db.prepare(`
    SELECT m.* FROM matches m
    LEFT JOIN results r ON r.match_id = m.id
    WHERE r.id IS NULL AND m.match_time > ?
    ORDER BY m.match_time ASC LIMIT 1
  `).get(now);

  // ── Active round window ───────────────────────────────────────────────────
  const allGroupIds = db.prepare("SELECT id FROM matches WHERE round='group' ORDER BY match_time, id").all().map(r => r.id);
  const lastStarted = db.prepare(`SELECT id, round FROM matches WHERE match_time <= ? ORDER BY match_time DESC LIMIT 1`).get(now);
  const refMatch = lastStarted || nextMatch;

  let roundFilter = '1=1'; // bare SQL fragment (no leading AND)
  if (refMatch) {
    if (refMatch.round !== 'group') {
      roundFilter = `m.round = '${refMatch.round}'`;
    } else {
      const refIdx = allGroupIds.indexOf(refMatch.id);
      const mdIds = refIdx < 24 ? allGroupIds.slice(0, 24)
                  : refIdx < 48 ? allGroupIds.slice(24, 48)
                  : allGroupIds.slice(48);
      if (mdIds.length > 0) roundFilter = `m.id IN (${mdIds.join(',')})`;
    }
  }
  const navFilter = roundFilter === '1=1' ? '' : `AND ${roundFilter}`;

  // All matches in the active round — for "Predict Now" section
  const upcoming = db.prepare(`
    SELECT m.*, r.result, r.aet_result, p.prediction, p.aet_prediction
    FROM matches m
    LEFT JOIN results r ON r.match_id = m.id
    LEFT JOIN predictions p ON p.match_id = m.id AND p.user_id = ?
    WHERE ${roundFilter}
    ORDER BY m.match_time ASC
  `).all(userId);

  // Recent results — today and yesterday (KWT) only
  const recent = db.prepare(`
    SELECT m.*, r.result, r.aet_result, p.prediction, p.aet_prediction
    FROM matches m
    JOIN results r ON r.match_id = m.id
    LEFT JOIN predictions p ON p.match_id = m.id AND p.user_id = ?
    WHERE date(datetime(m.match_time, '+3 hours')) >= date(datetime('now', '+3 hours', '-1 day'))
    ORDER BY m.match_time DESC
    LIMIT 10
  `).all(userId);

  // Total points
  const allPredictions = db.prepare(`
    SELECT p.*, m.round, m.is_knockout, r.result, r.aet_result
    FROM predictions p
    JOIN matches m ON m.id = p.match_id
    LEFT JOIN results r ON r.match_id = p.match_id
    WHERE p.user_id = ?
  `).all(userId);

  let totalPts = 0, groupPts = 0, knockoutPts = 0, bonusPts = 0, correct = 0;
  allPredictions.forEach(p => {
    const pts = calculateMatchPoints(p, { result: p.result, aet_result: p.aet_result }, p);
    if (pts.main > 0) { correct++; }
    if (p.round === 'group') { groupPts += pts.main; }
    else { knockoutPts += pts.main; bonusPts += pts.bonus; }
    totalPts += pts.main + pts.bonus;
  });

  // Rank + full leaderboard
  const { computeLeaderboard } = require('../db/database');
  const lb = computeLeaderboard(db);
  const myRank = lb.find(r => r.id === userId)?.rank || '-';
  const totalUsers = lb.length;

  // Navigable list: today's past/ongoing + upcoming unplayed, within active window
  const navList = db.prepare(`
    SELECT m.id, m.team_a, m.team_b, m.match_time, m.round, m.group_name, m.is_locked,
           r.result IS NOT NULL as has_result, r.result as match_result
    FROM matches m
    LEFT JOIN results r ON r.match_id = m.id
    WHERE (
      (date(datetime(m.match_time, '+3 hours')) = ? AND m.match_time <= ?)
      OR (r.id IS NULL AND m.match_time > ?)
    ) ${navFilter}
    ORDER BY m.match_time ASC
    LIMIT 20
  `).all(todayKwt, now, now);

  // Current display match: use ?matchId param if valid, else default to nextMatch
  const reqMatchId = req.query.matchId ? parseInt(req.query.matchId) : null;
  const displayMatch = (reqMatchId && navList.find(m => m.id === reqMatchId))
    || nextMatch
    || navList[0] || null;

  const displayIdx = navList.findIndex(m => m.id === displayMatch?.id);
  const prevNavMatch = displayIdx > 0 ? navList[displayIdx - 1] : null;
  const nextNavMatch = displayIdx >= 0 && displayIdx < navList.length - 1 ? navList[displayIdx + 1] : null;

  // Visibility check for displayed match's round
  function getRoundKey(match) {
    if (match.round !== 'group') return match.round;
    const allGroupIds = db.prepare("SELECT id FROM matches WHERE round='group' ORDER BY match_time, id").all().map(r => r.id);
    const idx = allGroupIds.indexOf(match.id);
    return idx < 24 ? 'group_md1' : idx < 48 ? 'group_md2' : 'group_md3';
  }
  let displayRoundVisible = req.session.user.is_admin;
  if (!displayRoundVisible && displayMatch) {
    const visRow = db.prepare("SELECT visible FROM round_visibility WHERE round = ?").get(getRoundKey(displayMatch));
    displayRoundVisible = !!(visRow && visRow.visible === 1);
  }

  // All users' predictions for the displayed match
  const nextPredMap = {};
  if (displayMatch) {
    db.prepare('SELECT user_id, prediction FROM predictions WHERE match_id = ?')
      .all(displayMatch.id).forEach(p => { nextPredMap[p.user_id] = p.prediction; });
  }

  res.render('dashboard', {
    title: 'My Dashboard',
    upcoming: upcoming.map(m => ({ ...m, match_time_kwt: toKuwaitTimeShort(m.match_time) })),
    recent: recent.map(m => {
      const pts = calculateMatchPoints(m, { result: m.result, aet_result: m.aet_result }, m);
      return { ...m, match_time_kwt: toKuwaitTimeShort(m.match_time), pts };
    }),
    stats: { totalPts, groupPts, knockoutPts, bonusPts, correct, rank: myRank, totalUsers },
    leaderboard: lb,
    nextMatch,         // absolute next game (for auto-refresh check)
    displayMatch: displayMatch ? { ...displayMatch, match_time_kwt: toKuwaitTimeShort(displayMatch.match_time) } : null,
    prevNavMatch,
    nextNavMatch,
    nextPredMap,
    nextMatchRoundVisible: displayRoundVisible
  });
});

// ── Knockout → official overall match number offset ───────────────────────────
const KO_OFFSETS = { r32: 72, r16: 88, qf: 96, sf: 100, '3rd': 102, final: 103 };

// ── Match list ────────────────────────────────────────────────────────────────
router.get('/matches', requireLogin, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const { round, group } = req.query;

  // Precompute time-order rank for group matches → matchday assignment
  const groupRanks = {};
  db.prepare("SELECT id FROM matches WHERE round='group' ORDER BY match_time, id").all()
    .forEach((r, i) => { groupRanks[r.id] = i + 1; });

  let query = `
    SELECT m.*, r.result, r.aet_result, r.score_a, r.score_b, p.prediction, p.aet_prediction
    FROM matches m
    LEFT JOIN results r ON r.match_id = m.id
    LEFT JOIN predictions p ON p.match_id = m.id AND p.user_id = ?
  `;
  const params = [userId];

  if (round) { query += ' WHERE m.round = ?'; params.push(round); }
  else if (group) { query += ' WHERE m.group_name = ?'; params.push(group); }

  query += ' ORDER BY m.match_time ASC';

  const matches = db.prepare(query).all(...params);

  res.render('matches', {
    title: 'Match Predictions',
    matches: matches.map(m => {
      const pts = calculateMatchPoints(m, { result: m.result, aet_result: m.aet_result }, m);
      const timeRank = m.group_name ? (groupRanks[m.id] || 0) : 0;
      const matchday = timeRank <= 24 ? 1 : timeRank <= 48 ? 2 : 3;
      const officialNum = m.group_name ? timeRank : (KO_OFFSETS[m.round] || 0) + m.match_num;
      return { ...m, match_time_kwt: toKuwaitTime(m.match_time), pts, matchday, officialNum };
    }),
    filter: { round, group },
    groups: 'ABCDEFGHIJKL'.split('')
  });
});

// ── Single match prediction ───────────────────────────────────────────────────
router.get('/matches/:id', requireLogin, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const matchId = parseInt(req.params.id);

  const match = db.prepare(`
    SELECT m.*, r.result, r.aet_result
    FROM matches m
    LEFT JOIN results r ON r.match_id = m.id
    WHERE m.id = ?
  `).get(matchId);

  if (!match) {
    req.session.flashError = 'Match not found.';
    return res.redirect('/matches');
  }

  const prediction = db.prepare('SELECT * FROM predictions WHERE user_id = ? AND match_id = ?').get(userId, matchId);

  // Admin always sees all predictions; users see them once match is locked or has result
  let otherPreds = [];
  if (req.session.user.is_admin || match.is_locked || match.result) {
    otherPreds = db.prepare(`
      SELECT u.username, u.display_name, p.prediction, p.aet_prediction
      FROM predictions p
      JOIN users u ON u.id = p.user_id
      WHERE p.match_id = ? AND p.user_id != ?
      ORDER BY u.username
    `).all(matchId, userId);
  }

  const pts = prediction ? calculateMatchPoints(prediction, { result: match.result, aet_result: match.aet_result }, match) : null;

  res.render('match-detail', {
    title: `${match.team_a} vs ${match.team_b}`,
    match: { ...match, match_time_kwt: toKuwaitTime(match.match_time) },
    prediction,
    pts,
    otherPreds
  });
});

// ── Batch prediction ──────────────────────────────────────────────────────────
router.post('/matches/predict-batch', requireLogin, (req, res) => {
  if (req.session.user.is_admin) return res.json({ ok: false, errors: ['Admin cannot predict'] });

  const db = getDb();
  const userId = req.session.user.id;
  const { predictions } = req.body;

  if (!Array.isArray(predictions) || predictions.length === 0) {
    return res.json({ ok: false, errors: ['No predictions provided'] });
  }

  const savePred = db.prepare(`
    INSERT INTO predictions (user_id, match_id, prediction, aet_prediction, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (user_id, match_id) DO UPDATE SET
      prediction = excluded.prediction,
      aet_prediction = excluded.aet_prediction,
      updated_at = CURRENT_TIMESTAMP
  `);

  const saved = [];
  const errors = [];

  for (const p of predictions) {
    const { matchId, prediction, aet_prediction } = p;
    if (!matchId || !prediction) { errors.push(`Missing data for match ${matchId}`); continue; }
    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
    if (!match) { errors.push(`Match ${matchId} not found`); continue; }
    if (match.is_locked) { errors.push(`Match ${matchId} locked`); continue; }
    if (db.prepare('SELECT id FROM results WHERE match_id = ?').get(matchId)) {
      errors.push(`Match ${matchId} already has result`); continue;
    }
    const validPreds = ['team_a', 'draw', 'team_b'];
    if (!validPreds.includes(prediction)) { errors.push(`Invalid prediction for ${matchId}`); continue; }
    if (match.is_knockout && prediction === 'draw') { errors.push(`No draw in knockout (${matchId})`); continue; }
    if (match.is_knockout && !['90min', 'aet'].includes(aet_prediction)) {
      errors.push(`AET required for knockout match ${matchId}`); continue;
    }
    savePred.run(userId, matchId, prediction, match.is_knockout ? aet_prediction : null);
    saved.push(matchId);
  }

  res.json({ ok: true, saved, errors });
});

// ── Submit / update prediction ────────────────────────────────────────────────
router.post('/matches/:id/predict', requireLogin, (req, res) => {
  if (req.session.user.is_admin) return res.redirect(req.body._returnTo || '/matches');
  const db = getDb();
  const userId = req.session.user.id;
  const matchId = parseInt(req.params.id);

  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!match) {
    req.session.flashError = 'Match not found.';
    return res.redirect('/matches');
  }
  const returnTo = req.body._returnTo || '/matches';

  if (match.is_locked) {
    req.session.flashError = 'Predictions are locked for this match.';
    return res.redirect(returnTo);
  }

  // Check if result already in
  const result = db.prepare('SELECT id FROM results WHERE match_id = ?').get(matchId);
  if (result) {
    req.session.flashError = 'This match has already been played.';
    return res.redirect(returnTo);
  }

  const { prediction, aet_prediction } = req.body;
  const validPreds = ['team_a', 'draw', 'team_b'];
  if (!validPreds.includes(prediction)) {
    req.session.flashError = 'Invalid prediction. Please select a valid option.';
    return res.redirect(returnTo);
  }

  // For knockout, draw not allowed
  if (match.is_knockout && prediction === 'draw') {
    req.session.flashError = 'Draw is not allowed in knockout rounds.';
    return res.redirect(returnTo);
  }

  // For knockout, aet_prediction required
  if (match.is_knockout && !['90min', 'aet'].includes(aet_prediction)) {
    req.session.flashError = 'Please select whether the match ends in 90 minutes or AET.';
    return res.redirect(returnTo);
  }

  db.prepare(`
    INSERT INTO predictions (user_id, match_id, prediction, aet_prediction, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (user_id, match_id) DO UPDATE SET
      prediction = excluded.prediction,
      aet_prediction = excluded.aet_prediction,
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, matchId, prediction, match.is_knockout ? aet_prediction : null);

  req.session.flashSuccess = '✅ Prediction saved!';
  res.redirect(returnTo);
});

// ── API: next match ID (used by dashboard auto-refresh) ───────────────────────
router.get('/api/next-match', requireLogin, (req, res) => {
  const db = getDb();
  const now = new Date().toISOString();
  const m = db.prepare(`
    SELECT m.id FROM matches m
    LEFT JOIN results r ON r.match_id = m.id
    WHERE r.id IS NULL AND m.match_time > ?
    ORDER BY m.match_time ASC LIMIT 1
  `).get(now);
  res.json({ id: m ? m.id : null });
});

// ── Rules ─────────────────────────────────────────────────────────────────────
router.get('/rules', requireLogin, (req, res) => {
  res.render('rules', { title: 'Competition Rules' });
});

// ── View another user's predictions (from leaderboard) ───────────────────────
router.get('/users/:id/predictions', requireLogin, (req, res) => {
  const db = getDb();
  const viewerId = req.session.user.id;
  const isAdmin = req.session.user.is_admin;
  const targetId = parseInt(req.params.id);

  // Can't view own predictions this way (redirect to dashboard)
  if (targetId === viewerId && !isAdmin) return res.redirect('/dashboard');

  const targetUser = db.prepare('SELECT id, username, display_name FROM users WHERE id = ? AND is_admin = 0').get(targetId);
  if (!targetUser) { req.session.flashError = 'User not found.'; return res.redirect('/dashboard'); }

  // Determine visible rounds (admin sees all)
  let visibleRounds = null; // null = all
  if (!isAdmin) {
    const visRows = db.prepare('SELECT round FROM round_visibility WHERE visible = 1').all();
    visibleRounds = new Set(visRows.map(r => r.round));
  }

  // Precompute group match IDs → matchday key
  const allGroupIds = db.prepare("SELECT id FROM matches WHERE round='group' ORDER BY match_time, id").all().map(r => r.id);
  const md1Ids = new Set(allGroupIds.slice(0, 24));
  const md2Ids = new Set(allGroupIds.slice(24, 48));
  function matchdayKey(matchId, round) {
    if (round !== 'group') return round;
    if (md1Ids.has(matchId)) return 'group_md1';
    if (md2Ids.has(matchId)) return 'group_md2';
    return 'group_md3';
  }

  // Fetch all predictions for target user
  const allPreds = db.prepare(`
    SELECT p.*, m.team_a, m.team_b, m.round, m.group_name, m.match_time, m.is_knockout,
           r.result, r.aet_result
    FROM predictions p
    JOIN matches m ON m.id = p.match_id
    LEFT JOIN results r ON r.match_id = p.match_id
    WHERE p.user_id = ?
    ORDER BY m.match_time ASC
  `).all(targetId);

  // Filter by visibility
  const preds = allPreds.filter(p => {
    if (!visibleRounds) return true; // admin sees all
    const key = matchdayKey(p.match_id, p.round);
    return visibleRounds.has(key);
  });

  res.render('user-predictions', {
    title: `${targetUser.display_name || targetUser.username}'s Predictions`,
    targetUser,
    preds: preds.map(p => ({ ...p, match_time_kwt: toKuwaitTime(p.match_time) })),
    isAdmin,
    viewerName: req.session.user.display_name || req.session.user.username
  });
});

module.exports = router;
