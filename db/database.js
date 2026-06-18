const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_DIR = process.env.DB_PATH || __dirname;
const DB_PATH = path.join(DB_DIR, 'wc2026.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    -- ── Users ──────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name  TEXT,
      is_admin   INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Matches ────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS matches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      round       TEXT NOT NULL,   -- 'group','r32','r16','qf','sf','3rd','final'
      group_name  TEXT,            -- 'A'..'L' for group stage, NULL for knockout
      match_num   INTEGER,         -- match number within round for ordering
      team_a      TEXT NOT NULL,
      team_b      TEXT NOT NULL,
      match_time  TEXT NOT NULL,   -- ISO datetime stored in UTC
      stadium     TEXT,
      city        TEXT,
      is_knockout INTEGER DEFAULT 0,
      is_locked   INTEGER DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Results ────────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS results (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id   INTEGER UNIQUE NOT NULL,
      result     TEXT,   -- 'team_a' | 'draw' | 'team_b'
      aet_result TEXT,   -- '90min' | 'aet'  (knockout only, NULL for group)
      entered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
    );

    -- ── Predictions ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS predictions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL,
      match_id       INTEGER NOT NULL,
      prediction     TEXT NOT NULL,  -- 'team_a' | 'draw' | 'team_b'
      aet_prediction TEXT,           -- '90min' | 'aet' (knockout only)
      submitted_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, match_id),
      FOREIGN KEY (user_id)  REFERENCES users(id)   ON DELETE CASCADE,
      FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
    );

    -- ── Award Categories ───────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS award_categories (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      points         INTEGER DEFAULT 10,
      is_locked      INTEGER DEFAULT 0,
      winner_option_id INTEGER,
      sort_order     INTEGER DEFAULT 0
    );

    -- ── Award Options ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS award_options (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      name        TEXT NOT NULL,
      FOREIGN KEY (category_id) REFERENCES award_categories(id) ON DELETE CASCADE
    );

    -- ── Award Predictions ──────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS award_predictions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      category_id INTEGER NOT NULL,
      option_id   INTEGER NOT NULL,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, category_id),
      FOREIGN KEY (user_id)     REFERENCES users(id)            ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES award_categories(id) ON DELETE CASCADE,
      FOREIGN KEY (option_id)   REFERENCES award_options(id)    ON DELETE CASCADE
    );

    -- ── Admin Activity Log ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS admin_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id   INTEGER NOT NULL,
      action     TEXT NOT NULL,
      details    TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (admin_id) REFERENCES users(id)
    );

    -- ── Indexes ────────────────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_predictions_user    ON predictions(user_id);
    CREATE INDEX IF NOT EXISTS idx_predictions_match   ON predictions(match_id);
    CREATE INDEX IF NOT EXISTS idx_matches_round       ON matches(round);
    CREATE INDEX IF NOT EXISTS idx_award_options_cat   ON award_options(category_id);
    CREATE INDEX IF NOT EXISTS idx_award_pred_user     ON award_predictions(user_id);
  `);

  seedInitialData();
}

function seedInitialData() {
  // ── Admin user ─────────────────────────────────────────────────────────────
  const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare(
      'INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, 1)'
    ).run('admin', 'Administrator', hash);
    console.log('✅ Admin user created: admin / admin123');
  }

  // ── Award categories ───────────────────────────────────────────────────────
  const awardsExist = db.prepare('SELECT id FROM award_categories LIMIT 1').get();
  if (!awardsExist) {
    const insertCat = db.prepare(
      'INSERT INTO award_categories (name, points, sort_order) VALUES (?, 10, ?)'
    );
    const categories = [
      'Top Goalscorer',
      'Best Player (Golden Ball)',
      'Best Young Player',
      'Best Goalkeeper (Golden Glove)',
      'Fair Play Award'
    ];
    categories.forEach((name, i) => insertCat.run(name, i));
    console.log('✅ Award categories seeded');
  }

  // ── WC 2026 Group Stage Fixtures ───────────────────────────────────────────
  // 48 teams, 12 groups (A–L), 4 teams each, 6 matches per group = 72 total
  // Times stored in UTC (Kuwait is UTC+3, so midnight KWT = 21:00 UTC prev day)
  const matchesExist = db.prepare('SELECT id FROM matches LIMIT 1').get();
  if (!matchesExist) {
    seedMatches();
  }
}

function seedMatches() {
  const insertMatch = db.prepare(`
    INSERT INTO matches (round, group_name, match_num, team_a, team_b, match_time, stadium, city, is_knockout, is_locked)
    VALUES (@round, @group_name, @match_num, @team_a, @team_b, @match_time, @stadium, @city, @is_knockout, @is_locked)
  `);

  // ── FIFA WC 2026 Groups ────────────────────────────────────────────────────
  // (Groups confirmed after the Dec 2025 draw)
  const groups = {
    A: ['Mexico', 'Uruguay', 'Cameroon', 'Tunisia'],
    B: ['USA', 'Panama', 'Qatar', 'New Zealand'],
    C: ['Canada', 'Morocco', 'Croatia', 'Belgium'],
    D: ['Argentina', 'Chile', 'Saudi Arabia', 'Albania'],
    E: ['Spain', 'Ukraine', 'Serbia', 'Algeria'],
    F: ['Portugal', 'Czech Republic', 'Nigeria', 'Egypt'],
    G: ['Brazil', 'Colombia', 'Venezuela', 'South Korea'],
    H: ['England', 'Senegal', 'Slovakia', 'Paraguay'],
    I: ['France', 'Australia', 'Cameroon', 'Guatemala'],
    J: ['Germany', 'Switzerland', 'Italy', 'Iran'],
    K: ['Netherlands', 'Poland', 'Congo DR', 'Peru'],
    L: ['Japan', 'Ecuador', 'Burkina Faso', 'Costa Rica']
  };

  // Generate group stage matches for each group
  // Each group: match1 (T1vT2), match2 (T3vT4), match3 (T1vT3), match4 (T2vT4), match5 (T1vT4), match6 (T2vT3)
  const groupMatchups = [
    [0, 1], [2, 3],
    [0, 2], [1, 3],
    [0, 3], [1, 2]
  ];

  // Base date: June 11, 2026 (tournament start), in UTC
  const baseDate = new Date('2026-06-11T18:00:00Z'); // 9pm KWT = 18:00 UTC

  const groupKeys = Object.keys(groups);
  let matchNum = 1;

  // Assign dates: 6 match days for group stage round 1–3 (2 rounds × 6 days each = 12 group-stage days)
  // Simplified: spread 72 matches across 18 days (Jun 11 – Jun 28)
  const seedTx = db.transaction(() => {
    groupKeys.forEach((grp, gi) => {
      const teams = groups[grp];
      groupMatchups.forEach(([a, b], mi) => {
        // Spread matches: first 2 matchdays (mi 0,1), second 2 (mi 2,3), third 2 (mi 4,5)
        const dayOffset = Math.floor(mi / 2) * 6 + Math.floor(gi / 2);
        const hourOffset = (gi % 2) * 3; // 18:00 or 21:00 UTC
        const matchTime = new Date(baseDate);
        matchTime.setDate(matchTime.getDate() + dayOffset);
        matchTime.setHours(18 + hourOffset);

        insertMatch.run({
          round: 'group',
          group_name: grp,
          match_num: matchNum++,
          team_a: teams[a],
          team_b: teams[b],
          match_time: matchTime.toISOString(),
          stadium: 'TBC',
          city: 'USA / Canada / Mexico',
          is_knockout: 0,
          is_locked: 0
        });
      });
    });

    // ── Round of 32 ──────────────────────────────────────────────────────────
    const r32Start = new Date('2026-07-01T18:00:00Z');
    const r32Matchups = [
      ['1A', '2C'], ['1C', '2A'], ['1B', '2D'], ['1D', '2B'],
      ['1E', '2G'], ['1G', '2E'], ['1F', '2H'], ['1H', '2F'],
      ['1I', '2K'], ['1K', '2I'], ['1J', '2L'], ['1L', '2J'],
      ['Best 3rd #1', 'Best 3rd #2'], ['Best 3rd #3', 'Best 3rd #4'],
      ['Best 3rd #5', 'Best 3rd #6'], ['Best 3rd #7', 'Best 3rd #8']
    ];
    r32Matchups.forEach(([a, b], i) => {
      const d = new Date(r32Start);
      d.setDate(d.getDate() + Math.floor(i / 4));
      d.setHours(18 + (i % 4 < 2 ? 0 : 3));
      insertMatch.run({
        round: 'r32', group_name: null, match_num: i + 1,
        team_a: a, team_b: b,
        match_time: d.toISOString(),
        stadium: 'TBC', city: 'USA / Canada / Mexico',
        is_knockout: 1, is_locked: 0
      });
    });

    // ── Round of 16 ──────────────────────────────────────────────────────────
    const r16Start = new Date('2026-07-05T18:00:00Z');
    for (let i = 0; i < 8; i++) {
      const d = new Date(r16Start);
      d.setDate(d.getDate() + Math.floor(i / 2));
      d.setHours(i % 2 === 0 ? 18 : 21);
      insertMatch.run({
        round: 'r16', group_name: null, match_num: i + 1,
        team_a: `R32 Winner ${i * 2 + 1}`, team_b: `R32 Winner ${i * 2 + 2}`,
        match_time: d.toISOString(),
        stadium: 'TBC', city: 'USA / Canada / Mexico',
        is_knockout: 1, is_locked: 0
      });
    }

    // ── Quarter-finals ────────────────────────────────────────────────────────
    const qfStart = new Date('2026-07-09T18:00:00Z');
    for (let i = 0; i < 4; i++) {
      const d = new Date(qfStart);
      d.setDate(d.getDate() + Math.floor(i / 2));
      d.setHours(i % 2 === 0 ? 18 : 21);
      insertMatch.run({
        round: 'qf', group_name: null, match_num: i + 1,
        team_a: `R16 Winner ${i * 2 + 1}`, team_b: `R16 Winner ${i * 2 + 2}`,
        match_time: d.toISOString(),
        stadium: 'TBC', city: 'USA / Canada / Mexico',
        is_knockout: 1, is_locked: 0
      });
    }

    // ── Semi-finals ───────────────────────────────────────────────────────────
    const sfStart = new Date('2026-07-14T18:00:00Z');
    for (let i = 0; i < 2; i++) {
      const d = new Date(sfStart);
      d.setDate(d.getDate() + i);
      insertMatch.run({
        round: 'sf', group_name: null, match_num: i + 1,
        team_a: `QF Winner ${i * 2 + 1}`, team_b: `QF Winner ${i * 2 + 2}`,
        match_time: d.toISOString(),
        stadium: 'MetLife Stadium', city: 'East Rutherford, NJ',
        is_knockout: 1, is_locked: 0
      });
    }

    // ── Third place match ─────────────────────────────────────────────────────
    insertMatch.run({
      round: '3rd', group_name: null, match_num: 1,
      team_a: 'SF Loser 1', team_b: 'SF Loser 2',
      match_time: '2026-07-18T18:00:00Z',
      stadium: 'Hard Rock Stadium', city: 'Miami, FL',
      is_knockout: 1, is_locked: 0
    });

    // ── Final ──────────────────────────────────────────────────────────────────
    insertMatch.run({
      round: 'final', group_name: null, match_num: 1,
      team_a: 'SF Winner 1', team_b: 'SF Winner 2',
      match_time: '2026-07-19T18:00:00Z',
      stadium: 'MetLife Stadium', city: 'East Rutherford, NJ',
      is_knockout: 1, is_locked: 0
    });
  });

  seedTx();
  console.log('✅ WC 2026 fixtures seeded (72 group + 32 knockout matches)');
}

// ── Scoring engine ─────────────────────────────────────────────────────────────
const ROUND_POINTS = {
  group: 1,
  r32:   2,
  r16:   3,
  qf:    4,
  sf:    5,
  '3rd': 4,
  final: 6
};

function calculateMatchPoints(prediction, result, match) {
  if (!result || !result.result || !prediction) return { main: 0, bonus: 0 };

  const correctWinner = prediction.prediction === result.result;
  if (!correctWinner) return { main: 0, bonus: 0 };

  const mainPts = ROUND_POINTS[match.round] || 1;
  let bonusPts = 0;

  if (match.is_knockout && result.aet_result && prediction.aet_prediction) {
    if (prediction.aet_prediction === result.aet_result) {
      bonusPts = 1;
    }
  }

  return { main: mainPts, bonus: bonusPts };
}

// ── Leaderboard computation ────────────────────────────────────────────────────
function computeLeaderboard(dbInstance) {
  const users = dbInstance.prepare(
    'SELECT id, username, display_name FROM users WHERE is_admin = 0'
  ).all();

  const matches = dbInstance.prepare('SELECT * FROM matches').all();
  const results = dbInstance.prepare('SELECT * FROM results').all();
  const predictions = dbInstance.prepare('SELECT * FROM predictions').all();
  const awardPredictions = dbInstance.prepare('SELECT ap.*, ac.points, ac.winner_option_id FROM award_predictions ap JOIN award_categories ac ON ap.category_id = ac.id').all();

  const resultMap = {};
  results.forEach(r => { resultMap[r.match_id] = r; });

  const matchMap = {};
  matches.forEach(m => { matchMap[m.id] = m; });

  const predMap = {};
  predictions.forEach(p => {
    if (!predMap[p.user_id]) predMap[p.user_id] = {};
    predMap[p.user_id][p.match_id] = p;
  });

  const awardMap = {};
  awardPredictions.forEach(ap => {
    if (!awardMap[ap.user_id]) awardMap[ap.user_id] = [];
    awardMap[ap.user_id].push(ap);
  });

  const rows = users.map(u => {
    let groupPts = 0, knockoutPts = 0, bonusPts = 0, awardPts = 0, correct = 0;
    const userPreds = predMap[u.id] || {};

    matches.forEach(m => {
      const pred = userPreds[m.id];
      const res  = resultMap[m.id];
      if (!pred || !res) return;

      const { main, bonus } = calculateMatchPoints(pred, res, m);
      if (main > 0) correct++;

      if (m.round === 'group') {
        groupPts += main;
      } else {
        knockoutPts += main;
        bonusPts   += bonus;
      }
    });

    // Award points
    const userAwards = awardMap[u.id] || [];
    userAwards.forEach(ap => {
      if (ap.winner_option_id && ap.option_id === ap.winner_option_id) {
        awardPts += ap.points;
      }
    });

    return {
      id: u.id,
      username: u.username,
      display_name: u.display_name || u.username,
      group_pts: groupPts,
      knockout_pts: knockoutPts,
      bonus_pts: bonusPts,
      award_pts: awardPts,
      total: groupPts + knockoutPts + bonusPts + awardPts,
      correct
    };
  });

  rows.sort((a, b) => b.total - a.total || b.correct - a.correct);
  rows.forEach((r, i) => { r.rank = i + 1; });

  return rows;
}

// ── Kuwait time helper ─────────────────────────────────────────────────────────
function toKuwaitTime(utcDateStr) {
  const d = new Date(utcDateStr);
  return d.toLocaleString('en-KW', {
    timeZone: 'Asia/Kuwait',
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function toKuwaitTimeShort(utcDateStr) {
  const d = new Date(utcDateStr);
  return d.toLocaleString('en-KW', {
    timeZone: 'Asia/Kuwait',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

module.exports = { getDb, calculateMatchPoints, computeLeaderboard, toKuwaitTime, toKuwaitTimeShort, ROUND_POINTS };
