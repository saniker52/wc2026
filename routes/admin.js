const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb, computeLeaderboard, toKuwaitTime } = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { syncFromESPN } = require('../utils/espnSync');

const router = express.Router();
router.use(requireAdmin);

// ── Helper: log admin action ───────────────────────────────────────────────────
function logAction(db, adminId, action, details) {
  db.prepare('INSERT INTO admin_log (admin_id, action, details) VALUES (?, ?, ?)').run(adminId, action, details || null);
}

// ── Admin Dashboard ───────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const db = getDb();
  const totalUsers   = db.prepare("SELECT COUNT(*) as c FROM users WHERE is_admin = 0").get().c;
  const totalMatches = db.prepare("SELECT COUNT(*) as c FROM matches").get().c;
  const resultsIn    = db.prepare("SELECT COUNT(*) as c FROM results").get().c;
  const lockedCount  = db.prepare("SELECT COUNT(*) as c FROM matches WHERE is_locked = 1").get().c;
  const totalPreds   = db.prepare("SELECT COUNT(*) as c FROM predictions").get().c;

  // Precompute group match IDs ordered by time for matchday assignment
  const gids = db.prepare("SELECT id FROM matches WHERE round='group' ORDER BY match_time, id").all().map(r => r.id);
  const md1Ids = gids.slice(0, 24);
  const md2Ids = gids.slice(24, 48);
  const md3Ids = gids.slice(48);
  const ic = ids => ids.length ? ids.join(',') : '0';

  const rndQ  = r => db.prepare(`SELECT COUNT(*) as c FROM matches WHERE round=?`).get(r).c;
  const rndQL = r => db.prepare(`SELECT COUNT(*) as c FROM matches WHERE round=? AND is_locked=1`).get(r).c;

  const lockStatus = {
    group_md1: { total: md1Ids.length, locked: db.prepare(`SELECT COUNT(*) as c FROM matches WHERE id IN (${ic(md1Ids)}) AND is_locked=1`).get().c },
    group_md2: { total: md2Ids.length, locked: db.prepare(`SELECT COUNT(*) as c FROM matches WHERE id IN (${ic(md2Ids)}) AND is_locked=1`).get().c },
    group_md3: { total: md3Ids.length, locked: db.prepare(`SELECT COUNT(*) as c FROM matches WHERE id IN (${ic(md3Ids)}) AND is_locked=1`).get().c },
    r32:   { total: rndQ('r32'),   locked: rndQL('r32')   },
    r16:   { total: rndQ('r16'),   locked: rndQL('r16')   },
    qf:    { total: rndQ('qf'),    locked: rndQL('qf')    },
    sf:    { total: rndQ('sf'),    locked: rndQL('sf')    },
    '3rd': { total: rndQ('3rd'),   locked: rndQL('3rd')   },
    final: { total: rndQ('final'), locked: rndQL('final') },
  };

  // Visibility status per round
  const visRows = db.prepare('SELECT round, visible FROM round_visibility').all();
  const visibilityStatus = {};
  visRows.forEach(r => { visibilityStatus[r.round] = r.visible; });

  // Recent log
  const recentLog = db.prepare(`
    SELECT al.*, u.username FROM admin_log al
    JOIN users u ON u.id = al.admin_id
    ORDER BY al.created_at DESC LIMIT 10
  `).all();

  // Matches needing results
  const pendingResults = db.prepare(`
    SELECT m.* FROM matches m
    LEFT JOIN results r ON r.match_id = m.id
    WHERE r.id IS NULL AND m.match_time < datetime('now')
    ORDER BY m.match_time ASC LIMIT 10
  `).all();

  res.render('admin/dashboard', {
    title: 'Admin Dashboard',
    stats: { totalUsers, totalMatches, resultsIn, lockedCount, totalPreds },
    lockStatus,
    visibilityStatus,
    recentLog,
    pendingResults: pendingResults.map(m => ({ ...m, match_time_kwt: toKuwaitTime(m.match_time) }))
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// MATCH MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════════

router.get('/matches', (req, res) => {
  const db = getDb();
  const { round } = req.query;
  let matches;
  if (round) {
    matches = db.prepare('SELECT m.*, r.result, r.aet_result FROM matches m LEFT JOIN results r ON r.match_id = m.id WHERE m.round = ? ORDER BY m.match_time').all(round);
  } else {
    matches = db.prepare('SELECT m.*, r.result, r.aet_result FROM matches m LEFT JOIN results r ON r.match_id = m.id ORDER BY m.match_time').all();
  }

  res.render('admin/matches', {
    title: 'Manage Matches',
    matches: matches.map(m => ({ ...m, match_time_kwt: toKuwaitTime(m.match_time) })),
    filter: round || 'all'
  });
});

// Add match form
router.get('/matches/new', (req, res) => {
  res.render('admin/match-form', { title: 'Add Match', match: null });
});

// Add match
router.post('/matches', (req, res) => {
  const db = getDb();
  const { round, group_name, team_a, team_b, match_time_kwt, stadium, city } = req.body;

  if (!round || !team_a || !team_b || !match_time_kwt) {
    req.session.flashError = 'Round, teams, and match time are required.';
    return res.redirect('/admin/matches/new');
  }

  // Convert KWT input to UTC (KWT = UTC+3)
  const localDate = new Date(match_time_kwt);
  const utcDate = new Date(localDate.getTime() - 3 * 60 * 60 * 1000);

  const isKnockout = ['r32','r16','qf','sf','3rd','final'].includes(round) ? 1 : 0;

  const info = db.prepare(`
    INSERT INTO matches (round, group_name, team_a, team_b, match_time, stadium, city, is_knockout)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(round, group_name || null, team_a.trim(), team_b.trim(), utcDate.toISOString(), stadium || 'TBC', city || 'TBC', isKnockout);

  logAction(db, req.session.user.id, 'ADD_MATCH', `Match #${info.lastInsertRowid}: ${team_a} vs ${team_b} (${round})`);
  req.session.flashSuccess = 'Match added successfully.';
  res.redirect('/admin/matches');
});

// Edit match form
router.get('/matches/:id/edit', (req, res) => {
  const db = getDb();
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!match) { req.session.flashError = 'Match not found.'; return res.redirect('/admin/matches'); }
  res.render('admin/match-form', { title: 'Edit Match', match });
});

// Lock / unlock entire round (supports group_md1, group_md2, group_md3, and regular rounds)
// ⚠️ MUST be before /matches/:id to avoid Express swallowing 'lock-round' as :id
router.post('/matches/lock-round', (req, res) => {
  const db = getDb();
  const { round, action } = req.body;
  const locked = action === 'lock' ? 1 : 0;
  let info, label;

  const allGids = db.prepare("SELECT id FROM matches WHERE round='group' ORDER BY match_time, id").all().map(r => r.id);
  const ic = ids => ids.length ? ids.join(',') : '0';
  if (round === 'group_md1') {
    const ids = allGids.slice(0, 24);
    info = db.prepare(`UPDATE matches SET is_locked=? WHERE id IN (${ic(ids)})`).run(locked);
    label = 'Group MD1 (Games 1–24)';
  } else if (round === 'group_md2') {
    const ids = allGids.slice(24, 48);
    info = db.prepare(`UPDATE matches SET is_locked=? WHERE id IN (${ic(ids)})`).run(locked);
    label = 'Group MD2 (Games 25–48)';
  } else if (round === 'group_md3') {
    const ids = allGids.slice(48);
    info = db.prepare(`UPDATE matches SET is_locked=? WHERE id IN (${ic(ids)})`).run(locked);
    label = 'Group MD3 (Games 49–72)';
  } else {
    info = db.prepare('UPDATE matches SET is_locked=? WHERE round=?').run(locked, round);
    label = round.toUpperCase();
  }

  logAction(db, req.session.user.id, action === 'lock' ? 'LOCK_ROUND' : 'UNLOCK_ROUND', `${label} (${info.changes} matches)`);
  req.session.flashSuccess = `${label}: ${info.changes} matches ${action === 'lock' ? 'locked 🔒' : 'unlocked 🔓'}.`;
  res.redirect('/admin');
});

// Update match
router.post('/matches/:id', (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const { round, group_name, team_a, team_b, match_time_kwt, stadium, city } = req.body;

  const localDate = new Date(match_time_kwt);
  const utcDate = new Date(localDate.getTime() - 3 * 60 * 60 * 1000);
  const isKnockout = ['r32','r16','qf','sf','3rd','final'].includes(round) ? 1 : 0;

  db.prepare(`
    UPDATE matches SET round=?, group_name=?, team_a=?, team_b=?, match_time=?, stadium=?, city=?, is_knockout=?
    WHERE id=?
  `).run(round, group_name || null, team_a.trim(), team_b.trim(), utcDate.toISOString(), stadium || 'TBC', city || 'TBC', isKnockout, id);

  logAction(db, req.session.user.id, 'EDIT_MATCH', `Match #${id}: ${team_a} vs ${team_b}`);
  req.session.flashSuccess = 'Match updated.';
  res.redirect('/admin/matches');
});

// Delete match
router.post('/matches/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM matches WHERE id = ?').run(req.params.id);
  logAction(db, req.session.user.id, 'DELETE_MATCH', `Match #${req.params.id}`);
  req.session.flashSuccess = 'Match deleted.';
  res.redirect('/admin/matches');
});

// Lock / unlock match
router.post('/matches/:id/lock', (req, res) => {
  const db = getDb();
  const { action } = req.body; // 'lock' or 'unlock'
  const locked = action === 'lock' ? 1 : 0;
  db.prepare('UPDATE matches SET is_locked = ? WHERE id = ?').run(locked, req.params.id);
  logAction(db, req.session.user.id, action === 'lock' ? 'LOCK_MATCH' : 'UNLOCK_MATCH', `Match #${req.params.id}`);
  req.session.flashSuccess = `Match ${action === 'lock' ? 'locked' : 'unlocked'}.`;
  res.redirect(req.get('Referer') || '/admin/matches');
});

// ════════════════════════════════════════════════════════════════════════════════
// ROUND VISIBILITY (show/hide other users' predictions per round)
// ════════════════════════════════════════════════════════════════════════════════

router.post('/rounds/:round/visibility', (req, res) => {
  const db = getDb();
  const { action } = req.body; // 'show' or 'hide'
  const visible = action === 'show' ? 1 : 0;
  db.prepare('INSERT OR REPLACE INTO round_visibility (round, visible) VALUES (?, ?)').run(req.params.round, visible);
  const labels = {
    group_md1: 'Group MD1', group_md2: 'Group MD2', group_md3: 'Group MD3',
    r32: 'Round of 32', r16: 'Round of 16', qf: 'Quarterfinals',
    sf: 'Semifinals', '3rd': 'Third Place', final: 'Final'
  };
  const label = labels[req.params.round] || req.params.round;
  logAction(db, req.session.user.id, action === 'show' ? 'SHOW_PREDICTIONS' : 'HIDE_PREDICTIONS', `${label} predictions now ${action === 'show' ? 'visible' : 'hidden'} to users`);
  req.session.flashSuccess = `${label}: predictions ${action === 'show' ? '👁 visible' : '🙈 hidden'} to users.`;
  res.redirect('/admin');
});

// ════════════════════════════════════════════════════════════════════════════════
// RESULTS ENTRY
// ════════════════════════════════════════════════════════════════════════════════

router.get('/results', (req, res) => {
  const db = getDb();
  const { round } = req.query;

  let matches;
  if (round) {
    matches = db.prepare(`
      SELECT m.*, r.result, r.aet_result, r.score_a, r.score_b FROM matches m
      LEFT JOIN results r ON r.match_id = m.id
      WHERE m.round = ? ORDER BY m.match_time
    `).all(round);
  } else {
    matches = db.prepare(`
      SELECT m.*, r.result, r.aet_result, r.score_a, r.score_b FROM matches m
      LEFT JOIN results r ON r.match_id = m.id
      ORDER BY m.match_time
    `).all();
  }

  res.render('admin/results', {
    title: 'Enter Results',
    matches: matches.map(m => ({ ...m, match_time_kwt: toKuwaitTime(m.match_time) })),
    filter: round || 'all'
  });
});

// Enter / update result
router.post('/results/:matchId', (req, res) => {
  const db = getDb();
  const matchId = parseInt(req.params.matchId);
  const { result, aet_result, score_a, score_b } = req.body;

  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!match) { req.session.flashError = 'Match not found.'; return res.redirect('/admin/results'); }

  const validResults = ['team_a', 'draw', 'team_b'];
  if (!validResults.includes(result)) {
    req.session.flashError = 'Invalid result.';
    return res.redirect('/admin/results');
  }
  if (match.is_knockout && result === 'draw') {
    req.session.flashError = 'Knockout matches cannot end in a draw.';
    return res.redirect('/admin/results');
  }

  const aetVal = match.is_knockout ? (aet_result || '90min') : null;
  const sA = score_a !== '' && score_a !== undefined ? parseInt(score_a) : null;
  const sB = score_b !== '' && score_b !== undefined ? parseInt(score_b) : null;

  db.prepare(`
    INSERT INTO results (match_id, result, aet_result, score_a, score_b) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (match_id) DO UPDATE SET result=excluded.result, aet_result=excluded.aet_result, score_a=excluded.score_a, score_b=excluded.score_b, entered_at=CURRENT_TIMESTAMP
  `).run(matchId, result, aetVal, sA, sB);

  db.prepare('UPDATE matches SET is_locked = 1 WHERE id = ?').run(matchId);
  logAction(db, req.session.user.id, 'ENTER_RESULT', `Match #${matchId}: ${match.team_a} vs ${match.team_b} → ${result}${aetVal ? ' (' + aetVal + ')' : ''}${sA !== null ? ' (' + sA + '-' + sB + ')' : ''}`);
  req.session.flashSuccess = `Result entered for ${match.team_a} vs ${match.team_b}.`;
  res.redirect('/admin/results');
});

// Delete result
router.post('/results/:matchId/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM results WHERE match_id = ?').run(req.params.matchId);
  logAction(db, req.session.user.id, 'DELETE_RESULT', `Match #${req.params.matchId}`);
  req.session.flashSuccess = 'Result removed.';
  res.redirect('/admin/results');
});

// ════════════════════════════════════════════════════════════════════════════════
// USER MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════════

router.get('/users', (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, username, display_name, is_admin, created_at FROM users ORDER BY username').all();
  const lb = computeLeaderboard(db);
  const rankMap = {};
  lb.forEach(r => { rankMap[r.id] = r; });

  res.render('admin/users', {
    title: 'Manage Users',
    users: users.map(u => ({ ...u, stats: rankMap[u.id] || null }))
  });
});

// Add user
router.post('/users', (req, res) => {
  const db = getDb();
  const { username, display_name, password, is_admin } = req.body;

  if (!username || !password) {
    req.session.flashError = 'Username and password are required.';
    return res.redirect('/admin/users');
  }
  if (password.length < 6) {
    req.session.flashError = 'Password must be at least 6 characters.';
    return res.redirect('/admin/users');
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) {
    req.session.flashError = `Username "${username}" already exists.`;
    return res.redirect('/admin/users');
  }

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, ?)').run(
    username.trim(), display_name?.trim() || username.trim(), hash, is_admin ? 1 : 0
  );

  logAction(db, req.session.user.id, 'ADD_USER', `User #${info.lastInsertRowid}: ${username}`);
  req.session.flashSuccess = `User "${username}" created.`;
  res.redirect('/admin/users');
});

// Reset password
router.post('/users/:id/reset-password', (req, res) => {
  const db = getDb();
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) {
    req.session.flashError = 'Password must be at least 6 characters.';
    return res.redirect('/admin/users');
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
  logAction(db, req.session.user.id, 'RESET_PASSWORD', `User #${req.params.id}`);
  req.session.flashSuccess = 'Password reset.';
  res.redirect('/admin/users');
});

// Delete user
router.post('/users/:id/delete', (req, res) => {
  const db = getDb();
  if (parseInt(req.params.id) === req.session.user.id) {
    req.session.flashError = 'You cannot delete your own admin account.';
    return res.redirect('/admin/users');
  }
  const u = db.prepare('SELECT username FROM users WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  logAction(db, req.session.user.id, 'DELETE_USER', `User: ${u?.username}`);
  req.session.flashSuccess = `User "${u?.username}" deleted.`;
  res.redirect('/admin/users');
});

// View user's predictions
router.get('/users/:id/predictions', (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(req.params.id);
  if (!u) { req.session.flashError = 'User not found.'; return res.redirect('/admin/users'); }

  const preds = db.prepare(`
    SELECT p.*, m.team_a, m.team_b, m.round, m.group_name, m.match_time, m.is_knockout,
           r.result, r.aet_result
    FROM predictions p
    JOIN matches m ON m.id = p.match_id
    LEFT JOIN results r ON r.match_id = p.match_id
    WHERE p.user_id = ?
    ORDER BY m.match_time
  `).all(req.params.id);

  res.render('admin/user-predictions', {
    title: `${u.display_name || u.username}'s Predictions`,
    targetUser: u,
    preds: preds.map(p => ({ ...p, match_time_kwt: toKuwaitTime(p.match_time) }))
  });
});

// Admin override prediction
router.post('/users/:uid/predictions/:mid', (req, res) => {
  const db = getDb();
  const { prediction, aet_prediction } = req.body;
  const uid = req.params.uid;
  const mid = req.params.mid;

  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(mid);

  db.prepare(`
    INSERT INTO predictions (user_id, match_id, prediction, aet_prediction, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (user_id, match_id) DO UPDATE SET
      prediction = excluded.prediction,
      aet_prediction = excluded.aet_prediction,
      updated_at = CURRENT_TIMESTAMP
  `).run(uid, mid, prediction, match?.is_knockout ? aet_prediction : null);

  logAction(db, req.session.user.id, 'OVERRIDE_PREDICTION', `User #${uid}, Match #${mid}: ${prediction}`);
  req.session.flashSuccess = 'Prediction overridden.';
  res.redirect(`/admin/users/${uid}/predictions`);
});

// Manual points override (stored as a special "manual" match result entry)
router.post('/users/:id/points-override', (req, res) => {
  // Logged only — admin can manually track via audit log
  const db = getDb();
  const { reason, points } = req.body;
  logAction(db, req.session.user.id, 'POINTS_OVERRIDE', `User #${req.params.id}: ${points > 0 ? '+' : ''}${points} pts — ${reason}`);
  req.session.flashSuccess = `Points override logged (${points} pts). Note: manual points are tracked in the audit log only — adjust as needed.`;
  res.redirect(`/admin/users/${req.params.id}/predictions`);
});

// ════════════════════════════════════════════════════════════════════════════════
// AUDIT LOG
// ════════════════════════════════════════════════════════════════════════════════

router.get('/log', (req, res) => {
  const db = getDb();
  const logs = db.prepare(`
    SELECT al.*, u.username FROM admin_log al
    JOIN users u ON u.id = al.admin_id
    ORDER BY al.created_at DESC LIMIT 100
  `).all();
  res.render('admin/log', { title: 'Audit Log', logs });
});

// ════════════════════════════════════════════════════════════════════════════════
// SYNC SCORES FROM ESPN
// ════════════════════════════════════════════════════════════════════════════════

// (TEAM_MAP and sync logic live in utils/espnSync.js)
const _TEAM_MAP_UNUSED = {
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

router.post('/sync-scores', async (req, res) => {
  const db = getDb();
  const { synced, skipped, error } = await syncFromESPN(db);
  if (error) {
    req.session.flashError = `ESPN fetch failed: ${error}`;
    return res.redirect('/admin');
  }
  logAction(db, req.session.user.id, 'SYNC_SCORES', `Synced ${synced} results, skipped ${skipped}`);
  req.session.flashSuccess = `✅ Sync complete — ${synced} result(s) updated, ${skipped} skipped.`;
  res.redirect('/admin');
});

// ════════════════════════════════════════════════════════════════════════════════
// EXPORT
// ════════════════════════════════════════════════════════════════════════════════

router.get('/export/leaderboard', (req, res) => {
  const db = getDb();
  const lb = computeLeaderboard(db);
  const csv = [
    'Rank,Username,Display Name,Total,Group,Knockout,Bonus,Correct',
    ...lb.map(r => `${r.rank},"${r.username}","${r.display_name}",${r.total},${r.group_pts},${r.knockout_pts},${r.bonus_pts},${r.correct}`)
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="leaderboard.csv"');
  res.send(csv);
});

module.exports = router;
