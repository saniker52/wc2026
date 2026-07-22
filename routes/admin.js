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
  res.redirect(req.get('Referer') || '/admin');
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

// ── PDF Tournament Report ─────────────────────────────────────────────────────
router.get('/report/pdf', (req, res) => {
  const PDFDocument = require('pdfkit');
  const db = getDb();

  // ── Data gathering ──────────────────────────────────────────────────────────
  const rows = computeLeaderboard(db);

  const allMatches  = db.prepare('SELECT * FROM matches ORDER BY match_time ASC').all();
  const allResults  = db.prepare('SELECT r.*, m.team_a, m.team_b, m.round, m.is_knockout FROM results r JOIN matches m ON m.id = r.match_id').all();
  const allUsers    = db.prepare('SELECT id, display_name FROM users WHERE is_admin = 0').all();
  const allPreds    = db.prepare('SELECT * FROM predictions').all();

  const totalMatches  = allMatches.length;
  const played        = allResults.length;
  const pending       = totalMatches - played;
  const totalPreds    = allPreds.length;
  const maxPossible   = allUsers.length * totalMatches;

  // Per-round stats
  const ROUND_ORDER = ['group','r32','r16','qf','sf','3rd','final'];
  const ROUND_LABELS = { group:'Group Stage', r32:'Round of 32', r16:'Round of 16', qf:'Quarterfinals', sf:'Semifinals', '3rd':'3rd Place', final:'Final' };
  const roundStats = {};
  ROUND_ORDER.forEach(r => { roundStats[r] = { played:0, total:0 }; });
  allMatches.forEach(m => { if (roundStats[m.round]) roundStats[m.round].total++; });
  allResults.forEach(r => { if (roundStats[r.round]) roundStats[r.round].played++; });

  // AET/Penalties breakdown
  const aetCount = allResults.filter(r => r.aet_result === 'aet').length;
  const normalCount = allResults.filter(r => r.aet_result === '90min').length;

  // Top scorers
  const top3 = rows.slice(0, 3);

  // Most correct predictions
  const predMap = {};
  allPreds.forEach(p => { if (!predMap[p.user_id]) predMap[p.user_id] = []; predMap[p.user_id].push(p); });
  const resultMap = {};
  allResults.forEach(r => { resultMap[r.match_id] = r; });
  const matchMap = {};
  allMatches.forEach(m => { matchMap[m.id] = m; });

  // Match with lowest correct % (biggest upset)
  let hardestMatch = null, hardestPct = 101;
  allResults.forEach(r => {
    const preds = allPreds.filter(p => p.match_id === r.match_id && p.prediction);
    if (preds.length === 0) return;
    const correct = preds.filter(p => p.prediction === r.result).length;
    const pct = (correct / preds.length) * 100;
    if (pct < hardestPct) { hardestPct = pct; hardestMatch = r; }
  });

  // Prize pool
  const PRIZES = [200, 80, 50];
  const prizeMap = {};
  const byRank = {};
  rows.forEach(r => { if (!byRank[r.rank]) byRank[r.rank] = []; byRank[r.rank].push(r); });
  Object.entries(byRank).forEach(([rankStr, group]) => {
    const start = parseInt(rankStr);
    let total = 0;
    for (let i = start; i < start + group.length; i++) if (i <= PRIZES.length) total += PRIZES[i-1];
    if (total > 0) group.forEach(r => { prizeMap[r.id] = total / group.length; });
  });

  const now = new Date();
  const kwt = new Date(now.getTime() + 3*60*60*1000);
  const dateStr = kwt.toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'UTC' }) + ' (Kuwait Time)';

  // ── PDF Construction ────────────────────────────────────────────────────────
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: 'Chalet 1267 – WC 2026 Tournament Report', Author: 'Chalet 1267' } });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="chalet1267-wc2026-report.pdf"');
  doc.pipe(res);

  const W = doc.page.width - 100; // usable width
  const GOLD = '#B8860B';
  const DARK = '#1a1a2e';
  const GRAY = '#555555';
  const LGRAY = '#cccccc';

  // ── Cover header ────────────────────────────────────────────────────────────
  doc.rect(0, 0, doc.page.width, 120).fill(DARK);
  doc.fill('#ffffff').fontSize(22).font('Helvetica-Bold')
     .text('CHALET 1267', 50, 30, { align: 'center', width: doc.page.width - 100 });
  doc.fill(GOLD).fontSize(13).font('Helvetica')
     .text('FIFA World Cup 2026 — Tournament Predictions Report', 50, 58, { align: 'center', width: doc.page.width - 100 });
  doc.fill('#aaaaaa').fontSize(9)
     .text(`Generated: ${dateStr}`, 50, 84, { align: 'center', width: doc.page.width - 100 });

  doc.y = 140;

  // ── Tournament Snapshot ─────────────────────────────────────────────────────
  doc.fill(DARK).fontSize(13).font('Helvetica-Bold').text('Tournament Snapshot', 50, doc.y);
  doc.moveDown(0.4);
  doc.moveTo(50, doc.y).lineTo(50 + W, doc.y).strokeColor(GOLD).lineWidth(1.5).stroke();
  doc.moveDown(0.5);

  const snap = [
    ['Total Matches', `${played} / ${totalMatches} played (${pending} remaining)`],
    ['Predictions Submitted', `${totalPreds.toLocaleString()} / ${maxPossible.toLocaleString()} possible`],
    ['Decided in Extra Time / Pens', `${aetCount} matches (${normalCount} in 90 min)`],
    ['Players Competing', `${allUsers.length}`],
  ];
  snap.forEach(([label, val]) => {
    doc.fill(GRAY).fontSize(9).font('Helvetica-Bold').text(label, 50, doc.y, { continued: true, width: 200 });
    doc.fill('#222222').font('Helvetica').text(`  ${val}`, { width: W - 200 });
  });

  // Per-round breakdown
  doc.moveDown(0.5);
  doc.fill(DARK).fontSize(10).font('Helvetica-Bold').text('Matches by Round', 50, doc.y);
  doc.moveDown(0.3);
  ROUND_ORDER.forEach(r => {
    const s = roundStats[r];
    if (s.total === 0) return;
    const bar = s.total > 0 ? Math.round((s.played / s.total) * 100) : 0;
    doc.fill(GRAY).fontSize(8.5).font('Helvetica')
       .text(`${ROUND_LABELS[r]}`, 50, doc.y, { continued: true, width: 130 });
    doc.fill('#222222').text(`${s.played}/${s.total} played`, { width: 80, continued: true });
    doc.fill(bar === 100 ? '#16a34a' : GOLD).text(`(${bar}% complete)`, { width: 120 });
  });

  // ── Leaderboard Table ───────────────────────────────────────────────────────
  doc.moveDown(1);
  doc.fill(DARK).fontSize(13).font('Helvetica-Bold').text('Final Leaderboard', 50, doc.y);
  doc.moveDown(0.4);
  doc.moveTo(50, doc.y).lineTo(50 + W, doc.y).strokeColor(GOLD).lineWidth(1.5).stroke();
  doc.moveDown(0.5);

  // Table header
  const cols = { rank:30, name:120, grp:40, r32:35, r16:35, qf:35, sf:35, fin:38, bon:38, tot:40, prize:50 };
  const startX = 50;
  let cx = startX;

  doc.rect(startX, doc.y - 3, W, 16).fill('#f0f0f0');
  const headerY = doc.y;
  doc.fill(DARK).fontSize(7.5).font('Helvetica-Bold');
  const headers = [['#',cols.rank],['Player',cols.name],['Group',cols.grp],['R32',cols.r32],['R16',cols.r16],['QF',cols.qf],['SF',cols.sf],['3rd/Fin',cols.fin],['Bonus',cols.bon],['Total',cols.tot],['Prize KD',cols.prize]];
  headers.forEach(([h, w]) => {
    doc.text(h, cx + 2, headerY, { width: w - 4, align: h === 'Player' ? 'left' : 'center' });
    cx += w;
  });
  doc.moveDown(0.3);

  // Table rows
  rows.forEach((r, i) => {
    const rowY = doc.y;
    const isTop3 = r.rank <= 3;
    if (i % 2 === 0) doc.rect(startX, rowY - 2, W, 15).fill('#fafafa').stroke();
    if (isTop3) doc.rect(startX, rowY - 2, 3, 15).fill(GOLD);

    const prize = prizeMap[r.id];
    const prizeStr = prize ? (Number.isInteger(prize) ? `${prize}` : prize.toFixed(1)) : '—';
    const medal = r.rank === 1 ? '1.' : r.rank === 2 ? '2.' : r.rank === 3 ? '3.' : `${r.rank}.`;
    const cells = [
      [medal, cols.rank, isTop3 ? GOLD : GRAY],
      [r.display_name, cols.name, isTop3 ? DARK : '#333333'],
      [`${r.group_pts}`, cols.grp, GRAY],
      [`${r.r32_pts||0}`, cols.r32, GRAY],
      [`${r.r16_pts||0}`, cols.r16, GRAY],
      [`${r.qf_pts||0}`, cols.qf, GRAY],
      [`${r.sf_pts||0}`, cols.sf, GRAY],
      [`${r.final_pts||0}`, cols.fin, GRAY],
      [`${r.bonus_pts||0}`, cols.bon, '#b45309'],
      [`${r.total}`, cols.tot, isTop3 ? GOLD : DARK],
      [prizeStr, cols.prize, prize ? GOLD : GRAY],
    ];

    cx = startX;
    doc.fontSize(7.5).font(isTop3 ? 'Helvetica-Bold' : 'Helvetica');
    cells.forEach(([val, w, color]) => {
      doc.fill(color).text(val, cx + 2, rowY, { width: w - 4, align: val === r.display_name ? 'left' : 'center' });
      cx += w;
    });
    doc.moveDown(0.22);

    // Page break if near bottom
    if (doc.y > doc.page.height - 100) {
      doc.addPage();
      doc.y = 50;
    }
  });

  // ── Key Insights ────────────────────────────────────────────────────────────
  doc.moveDown(1);
  if (doc.y > doc.page.height - 180) { doc.addPage(); doc.y = 50; }

  doc.fill(DARK).fontSize(13).font('Helvetica-Bold').text('Key Insights', 50, doc.y);
  doc.moveDown(0.4);
  doc.moveTo(50, doc.y).lineTo(50 + W, doc.y).strokeColor(GOLD).lineWidth(1.5).stroke();
  doc.moveDown(0.6);

  const insights = [];

  if (top3[0]) insights.push(`🏆 Leader: ${top3[0].display_name} is in first place with ${top3[0].total} points (${top3[0].correct} correct predictions).`);
  if (top3[1] && top3[1].total === top3[0].total) insights.push(`⚖️  ${top3[0].display_name} and ${top3[1].display_name} are tied at ${top3[0].total} pts — prize will be split equally.`);
  if (hardestMatch) {
    const hm = matchMap[hardestMatch.match_id];
    const winner = hardestMatch.result === 'team_a' ? hm.team_a : hardestMatch.result === 'draw' ? 'Draw' : hm.team_b;
    insights.push(`😮 Biggest upset: ${hm.team_a} vs ${hm.team_b} — only ${hardestPct.toFixed(0)}% predicted the correct result (${winner}).`);
  }
  if (aetCount > 0) insights.push(`⏱️  ${aetCount} knockout match${aetCount > 1 ? 'es' : ''} went to extra time or penalties — bonus point predictions mattered.`);
  if (pending > 0) insights.push(`📅 ${pending} match${pending > 1 ? 'es' : ''} still remaining — standings may change.`);

  // Prize summary
  insights.push(`💰 Prize pool: 330 KD total (200 / 80 / 50 KD for 1st/2nd/3rd). Ties split the combined prize equally.`);

  insights.forEach(txt => {
    doc.fill('#333333').fontSize(9).font('Helvetica').text(txt, 50, doc.y, { width: W, lineGap: 2 });
    doc.moveDown(0.6);
  });

  // ── Prize Summary ───────────────────────────────────────────────────────────
  const prizees = rows.filter(r => prizeMap[r.id]);
  if (prizees.length > 0) {
    doc.moveDown(0.5);
    doc.fill(DARK).fontSize(11).font('Helvetica-Bold').text('Projected Prize Payouts', 50, doc.y);
    doc.moveDown(0.4);
    doc.moveTo(50, doc.y).lineTo(50 + W, doc.y).strokeColor(GOLD).lineWidth(1).stroke();
    doc.moveDown(0.5);
    prizees.forEach(r => {
      const p = prizeMap[r.id];
      const medal = r.rank === 1 ? '1st' : r.rank === 2 ? '2nd' : '3rd';
      doc.fill(GOLD).fontSize(9).font('Helvetica-Bold')
         .text(`${medal} Place — ${r.display_name}`, 50, doc.y, { continued: true, width: W - 80 });
      doc.fill(GOLD).text(`${Number.isInteger(p) ? p : p.toFixed(1)} KD`, { width: 80, align: 'right' });
    });
  }

  // ── Footer ──────────────────────────────────────────────────────────────────
  doc.moveDown(2);
  doc.moveTo(50, doc.y).lineTo(50 + W, doc.y).strokeColor(LGRAY).lineWidth(0.5).stroke();
  doc.moveDown(0.4);
  doc.fill(LGRAY).fontSize(8).font('Helvetica')
     .text('Chalet 1267 · WC 2026 Predictions · Private Competition', 50, doc.y, { align: 'center', width: W });

  doc.end();
});

module.exports = router;
