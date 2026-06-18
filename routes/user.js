const express = require('express');
const { getDb, calculateMatchPoints, toKuwaitTime, toKuwaitTimeShort } = require('../db/database');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/dashboard', requireLogin, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const now = new Date().toISOString();

  // Upcoming unlocked matches without predictions
  const upcoming = db.prepare(`
    SELECT m.*, r.result, r.aet_result, p.prediction, p.aet_prediction
    FROM matches m
    LEFT JOIN results r ON r.match_id = m.id
    LEFT JOIN predictions p ON p.match_id = m.id AND p.user_id = ?
    WHERE m.is_locked = 0 AND r.result IS NULL AND m.match_time > ?
    ORDER BY m.match_time ASC
    LIMIT 5
  `).all(userId, now);

  // Recent results with user's points
  const recent = db.prepare(`
    SELECT m.*, r.result, r.aet_result, p.prediction, p.aet_prediction
    FROM matches m
    JOIN results r ON r.match_id = m.id
    LEFT JOIN predictions p ON p.match_id = m.id AND p.user_id = ?
    ORDER BY r.entered_at DESC
    LIMIT 8
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

  // Rank + full leaderboard for dashboard
  const { computeLeaderboard } = require('../db/database');
  const lb = computeLeaderboard(db);
  const myRank = lb.find(r => r.id === userId)?.rank || '-';
  const totalUsers = lb.length;

  res.render('dashboard', {
    title: 'My Dashboard',
    upcoming: upcoming.map(m => ({ ...m, match_time_kwt: toKuwaitTimeShort(m.match_time) })),
    recent: recent.map(m => {
      const pts = calculateMatchPoints(m, { result: m.result, aet_result: m.aet_result }, m);
      return { ...m, match_time_kwt: toKuwaitTimeShort(m.match_time), pts };
    }),
    stats: { totalPts, groupPts, knockoutPts, bonusPts, correct, rank: myRank, totalUsers },
    leaderboard: lb
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

  // Predictions from other users (visible once locked or result in)
  let otherPreds = [];
  if (match.is_locked || match.result) {
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

// ── Rules ─────────────────────────────────────────────────────────────────────
router.get('/rules', requireLogin, (req, res) => {
  res.render('rules', { title: 'Competition Rules' });
});

module.exports = router;
