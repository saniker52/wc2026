const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_DIR = process.env.DB_PATH || __dirname;
const DB_PATH = path.join(DB_DIR, 'wc2026.db');

// Increment this to force a fixture re-seed on next startup
const DB_VERSION = 2;

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

    -- ── Admin Activity Log ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS admin_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id   INTEGER NOT NULL,
      action     TEXT NOT NULL,
      details    TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (admin_id) REFERENCES users(id)
    );

    -- ── Round visibility (admin-controlled per-round prediction visibility) ─────
    CREATE TABLE IF NOT EXISTS round_visibility (
      round   TEXT PRIMARY KEY,
      visible INTEGER DEFAULT 0
    );

    -- ── Indexes ────────────────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_predictions_user    ON predictions(user_id);
    CREATE INDEX IF NOT EXISTS idx_predictions_match   ON predictions(match_id);
    CREATE INDEX IF NOT EXISTS idx_matches_round       ON matches(round);
  `);

  seedInitialData();
}

function seedInitialData() {
  // ── Version / migration table ──────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS db_meta (key TEXT PRIMARY KEY, value TEXT)`);
  const versionRow = db.prepare(`SELECT value FROM db_meta WHERE key='version'`).get();
  const currentVersion = versionRow ? parseInt(versionRow.value) : 0;

  // ── Admin user ─────────────────────────────────────────────────────────────
  const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare(
      'INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, 1)'
    ).run('admin', 'Administrator', hash);
    console.log('✅ Admin user created: admin / admin123');
  }

  // ── Non-destructive schema additions ──────────────────────────────────────
  try { db.exec('ALTER TABLE results ADD COLUMN score_a INTEGER'); } catch(_) {}
  try { db.exec('ALTER TABLE results ADD COLUMN score_b INTEGER'); } catch(_) {}

  // ── Fixture migration ──────────────────────────────────────────────────────
  if (currentVersion < DB_VERSION) {
    console.log(`⚙️  Migrating fixtures to v${DB_VERSION}...`);
    db.exec(`DELETE FROM predictions`);
    db.exec(`DELETE FROM results`);
    db.exec(`DELETE FROM matches`);
    seedMatches();
    db.prepare(`INSERT OR REPLACE INTO db_meta (key, value) VALUES ('version', ?)`).run(String(DB_VERSION));
    console.log(`✅ Fixtures migrated to v${DB_VERSION}`);
  }

  // ── Seed competition users + predictions ───────────────────────────────────
  seedUsersAndPredictions();
}

function seedUsersAndPredictions() {
  const alreadySeeded = db.prepare(`SELECT value FROM db_meta WHERE key='users_seeded_v3'`).get();
  if (alreadySeeded) return;

  // First 48 group matches in chronological order (MD1 + MD2)
  const matches48 = db.prepare(
    "SELECT id, team_a, team_b FROM matches WHERE round='group' ORDER BY match_time, id LIMIT 48"
  ).all();
  if (matches48.length < 48) {
    console.log(`⚠️  Only ${matches48.length} group matches found — skipping user seed`);
    return;
  }

  // Strip emoji flags + lowercase for matching
  function norm(s) {
    return s.replace(/[\u{1F1E0}-\u{1F1FF}\u{1F3F4}\u{1F3F3}]/gu, '').trim().toLowerCase();
  }
  const ALIASES = { turkey: 'türkiye', columbia: 'colombia', bosnia: 'bosnia & herz.' };
  function mapPred(text, match) {
    if (!text || text.toLowerCase() === 'draw') return 'draw';
    const p = ALIASES[text.toLowerCase()] || text.toLowerCase();
    const a = norm(match.team_a), b = norm(match.team_b);
    if (a.includes(p) || p.includes(a)) return 'team_a';
    if (b.includes(p) || p.includes(b)) return 'team_b';
    console.warn(`  ⚠️  No match for "${text}" in "${match.team_a}" vs "${match.team_b}"`);
    return null;
  }

  const USERS = [
    { name:'Abdulaziz Aljanahi',  username:'Aljanahi',   password:'1122', preds:['Mexico','South Korea','Bosnia','Paraguay','Qatar','Morocco','Scotland','Turkey','Germany','Netherlands','Ecuador','Tunisia','Spain','Egypt','Uruguay','Iran','Senegal','Iraq','Algeria','Jordan','Portugal','Croatia','Ghana','Uzbekistan','Czechia','Draw','Canada','Draw','USA','Morocco','Brazil','Draw','Sweden','Germany','Ecuador','Japan','Spain','Belgium','Uruguay','Draw','Argentina','France','Norway','Draw','Portugal','England','Croatia','Columbia'] },
    { name:'Abdulaziz Alshabaan', username:'Alshabaan',  password:'2233', preds:['Draw','South Korea','Bosnia','USA','Switzerland','Brazil','Scotland','Turkey','Germany','Netherlands','Ecuador','Sweden','Spain','Belgium','Uruguay','New Zealand','France','Norway','Argentina','Jordan','Portugal','Draw','Ghana','Columbia','Czechia','Switzerland','Canada','Mexico','USA','Scotland','Brazil','Turkey','Netherlands','Germany','Ecuador','Japan','Spain','Belgium','Uruguay','New Zealand','Argentina','France','Norway','Jordan','Portugal','England','Croatia','Columbia'] },
    { name:'Abdulaziz Alyaseen',  username:'Alyaseen',   password:'3344', preds:['Mexico','Draw','Canada','USA','Switzerland','Morocco','Scotland','Draw','Germany','Netherlands','Ecuador','Sweden','Spain','Belgium','Uruguay','Iran','France','Norway','Argentina','Austria','Portugal','England','Draw','Columbia','Czechia','Switzerland','Canada','South Korea','USA','Draw','Brazil','Draw','Netherlands','Germany','Ecuador','Draw','Spain','Belgium','Uruguay','New Zealand','Argentina','France','Norway','Draw','Portugal','England','Croatia','Columbia'] },
    { name:'Abdulwahab Alghanim', username:'Alghanim',   password:'4455', preds:['Mexico','Draw','Draw','USA','Switzerland','Draw','Scotland','Turkey','Germany','Netherlands','Ecuador','Tunisia','Spain','Draw','Draw','Iran','France','Norway','Argentina','Austria','Portugal','England','Ghana','Columbia','Czechia','Switzerland','Canada','Draw','USA','Morocco','Brazil','Turkey','Netherlands','Germany','Ecuador','Japan','Spain','Belgium','Uruguay','Egypt','Argentina','France','Senegal','Algeria','Portugal','England','Croatia','Columbia'] },
    { name:'Barjas Albarjas',     username:'Albarjas',   password:'5566', preds:['Mexico','Draw','Canada','USA','Switzerland','Brazil','Scotland','Turkey','Germany','Netherlands','Ivory Coast','Sweden','Spain','Belgium','Uruguay','Iran','France','Norway','Argentina','Austria','Portugal','England','Ghana','Columbia','Czechia','Switzerland','Canada','Mexico','USA','Morocco','Brazil','Turkey','Netherlands','Germany','Ecuador','Japan','Spain','Belgium','Uruguay','Egypt','Argentina','France','Draw','Algeria','Portugal','England','Croatia','Columbia'] },
    { name:'Eid Almeshwat',       username:'Almeshwat',  password:'6677', preds:['Mexico','South Korea','Canada','USA','Switzerland','Brazil','Scotland','Australia','Germany','Netherlands','Ecuador','Sweden','Spain','Belgium','Uruguay','New Zealand','France','Norway','Argentina','Austria','Portugal','England','Ghana','Columbia','Czechia','Switzerland','Canada','Mexico','USA','Morocco','Brazil','Paraguay','Netherlands','Germany','Ecuador','Japan','Spain','Belgium','Uruguay','Egypt','Argentina','France','Norway','Algeria','Portugal','England','Croatia','Columbia'] },
    { name:'Fahad Alfulaij',      username:'Alfulaij',   password:'7788', preds:['Mexico','Draw','Canada','USA','Switzerland','Brazil','Draw','Australia','Germany','Netherlands','Ecuador','Sweden','Spain','Belgium','Uruguay','Draw','France','Norway','Argentina','Draw','Portugal','Croatia','Ghana','Columbia','Czechia','Switzerland','Canada','Mexico','USA','Scotland','Brazil','Turkey','Netherlands','Germany','Ecuador','Japan','Spain','Belgium','Uruguay','Egypt','Argentina','France','Norway','Draw','Portugal','Draw','Draw','Draw'] },
    { name:'Fahad Algashaan',     username:'Algashaan',  password:'8899', preds:['Mexico','South Korea','Canada','USA','Switzerland','Morocco','Scotland','Draw','Germany','Draw','Ivory Coast','Tunisia','Spain','Egypt','Draw','Iran','France','Norway','Argentina','Jordan','Portugal','England','Ghana','Columbia','Czechia','Switzerland','Qatar','Mexico','USA','Morocco','Brazil','Turkey','Netherlands','Ivory Coast','Ecuador','Japan','Spain','Belgium','Uruguay','Egypt','Argentina','France','Senegal','Jordan','Draw','England','Croatia','Columbia'] },
    { name:'Fawaz AlQatami',      username:'Alqatami',   password:'fawaz123', preds:['Mexico','South Korea','Bosnia','Paraguay','Switzerland','Brazil','Scotland','Turkey','Germany','Netherlands','Draw','Sweden','Spain','Belgium','Uruguay','Iran','France','Norway','Argentina','Jordan','Portugal','England','Ghana','Columbia','Czechia','Switzerland','Canada','Mexico','USA','Morocco','Brazil','Turkey','Netherlands','Germany','Ecuador','Japan','Spain','Belgium','Uruguay','Egypt','Argentina','France','Norway','Algeria','Portugal','England','Croatia','Columbia'] },
    { name:'Hamad Almubarak',     username:'Almubarak',  password:'9900', preds:['Mexico','South Korea','Bosnia','USA','Switzerland','Brazil','Scotland','Turkey','Germany','Japan','Ivory Coast','Sweden','Spain','Belgium','Saudi Arabia','Iran','France','Norway','Argentina','Austria','Portugal','England','Ghana','Columbia','Czechia','Switzerland','Qatar','South Korea','Australia','Morocco','Brazil','Turkey','Netherlands','Germany','Ecuador','Japan','Spain','Belgium','Uruguay','Egypt','Argentina','France','Norway','Algeria','Portugal','England','Croatia','Columbia'] },
    { name:'Hamad Almudhaf',      username:'Halmudhaf',  password:'1234', preds:['Mexico','Draw','Canada','Draw','Switzerland','Brazil','Draw','Turkey','Germany','Netherlands','Draw','Draw','Spain','Draw','Uruguay','Draw','France','Norway','Draw','Draw','Portugal','Draw','Draw','Columbia','Czechia','Draw','Draw','Draw','USA','Morocco','Brazil','Draw','Draw','Germany','Ecuador','Japan','Spain','Belgium','Uruguay','Draw','Argentina','France','Draw','Algeria','Portugal','England','Croatia','Columbia'] },
    { name:'Khaled Almudhaf',     username:'Kalmudhaf',  password:'5678', preds:['Mexico','Czechia','Bosnia','Draw','Switzerland','Brazil','Scotland','Turkey','Germany','Netherlands','Ecuador','Sweden','Spain','Belgium','Uruguay','New Zealand','France','Norway','Draw','Austria','Portugal','Draw','Ghana','Columbia','Czechia','Switzerland','Qatar','Mexico','USA','Morocco','Brazil','Turkey','Netherlands','Germany','Ecuador','Draw','Spain','Belgium','Uruguay','Egypt','Argentina','France','Norway','Draw','Portugal','England','Croatia','Columbia'] },
    { name:'Mohammed Alajran',    username:'Alajran',    password:'4321', preds:['Mexico','Draw','Canada','Paraguay','Switzerland','Brazil','Scotland','Turkey','Germany','Netherlands','Draw','Tunisia','Spain','Egypt','Saudi Arabia','Draw','France','Norway','Argentina','Austria','Portugal','England','Draw','Draw','South Africa','Draw','Qatar','Mexico','USA','Morocco','Brazil','Paraguay','Netherlands','Germany','Ecuador','Japan','Spain','Draw','Uruguay','Egypt','Argentina','France','Norway','Algeria','Portugal','England','Croatia','Draw'] },
    { name:'Mohammed Albargash',  username:'Albargash',  password:'8765', preds:['Mexico','South Korea','Canada','Paraguay','Qatar','Brazil','Scotland','Turkey','Germany','Japan','Ecuador','Tunisia','Spain','Belgium','Saudi Arabia','Iran','France','Norway','Argentina','Austria','Portugal','England','Ghana','Columbia','Czechia','Switzerland','Canada','Mexico','USA','Scotland','Brazil','Turkey','Netherlands','Germany','Ecuador','Japan','Spain','Belgium','Uruguay','Egypt','Argentina','France','Senegal','Jordan','Portugal','England','Croatia','Columbia'] },
    { name:'Musaad Almajdeli',    username:'Malmajdeli', password:'2211', preds:['Mexico','Draw','Bosnia','Paraguay','Switzerland','Draw','Scotland','Turkey','Germany','Draw','Ivory Coast','Draw','Spain','Belgium','Uruguay','Draw','Draw','Draw','Draw','Draw','Portugal','England','Ghana','Columbia','Draw','Bosnia','Canada','Mexico','USA','Draw','Brazil','Draw','Sweden','Germany','Ecuador','Japan','Spain','Draw','Cape Verde','Egypt','Argentina','France','Norway','Draw','Portugal','England','Croatia','Columbia'] },
    { name:'Sager Alameeri',      username:'Alameeri',   password:'3322', preds:['Mexico','Draw','Draw','USA','Switzerland','Brazil','Scotland','Turkey','Germany','Netherlands','Ivory Coast','Sweden','Spain','Belgium','Uruguay','Draw','France','Norway','Argentina','Jordan','Portugal','England','Ghana','Columbia','Czechia','Switzerland','Canada','Draw','Draw','Morocco','Brazil','Turkey','Netherlands','Germany','Ecuador','Japan','Spain','Belgium','Uruguay','Egypt','Argentina','France','Draw','Algeria','Portugal','England','Croatia','Draw'] },
    { name:'Saoud Almajdeli',     username:'Salmajdeli', password:'4433', preds:['Mexico','Czechia','Canada','USA','Switzerland','Draw','Scotland','Turkey','Germany','Draw','Ecuador','Sweden','Spain','Belgium','Uruguay','Draw','France','Norway','Argentina','Austria','Portugal','Draw','Draw','Columbia','Czechia','Draw','Canada','Draw','USA','Morocco','Brazil','Turkey','Netherlands','Germany','Ecuador','Japan','Spain','Belgium','Uruguay','Egypt','Argentina','France','Norway','Algeria','Portugal','England','Croatia','Columbia'] },
    { name:'Talal Almurjan',      username:'Almurjan',   password:'5544', preds:['Mexico','South Korea','Draw','Draw','Switzerland','Brazil','Scotland','Turkey','Germany','Draw','Draw','Sweden','Spain','Belgium','Uruguay','Iran','France','Norway','Argentina','Draw','Portugal','Draw','Draw','Columbia','Czechia','Draw','Canada','Draw','USA','Morocco','Brazil','Draw','Netherlands','Germany','Ecuador','Japan','Spain','Belgium','Draw','New Zealand','Argentina','France','Norway','Draw','Portugal','England','Croatia','Draw'] },
  ];

  const insertUser = db.prepare(
    'INSERT OR IGNORE INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, 0)'
  );
  const upsertPred = db.prepare(`
    INSERT INTO predictions (user_id, match_id, prediction, aet_prediction, updated_at)
    VALUES (?, ?, ?, NULL, CURRENT_TIMESTAMP)
    ON CONFLICT (user_id, match_id) DO UPDATE SET
      prediction = excluded.prediction,
      updated_at = CURRENT_TIMESTAMP
  `);
  const getUser = db.prepare('SELECT id FROM users WHERE username = ?');

  const doSeed = db.transaction(() => {
    let created = 0, preds = 0;
    for (const u of USERS) {
      insertUser.run(u.username, u.name, bcrypt.hashSync(String(u.password), 10));
      const userId = getUser.get(u.username).id;
      if (!getUser.get(u.username)) continue;
      created++;
      u.preds.forEach((text, i) => {
        const pred = mapPred(text, matches48[i]);
        if (pred) { upsertPred.run(userId, matches48[i].id, pred); preds++; }
      });
    }
    db.prepare(`INSERT OR REPLACE INTO db_meta (key, value) VALUES ('users_seeded_v3', '1')`).run();
    console.log(`✅ Seeded ${USERS.length} users + ${preds} predictions`);
  });
  doSeed();
}

function seedMatches() {
  const ins = db.prepare(`
    INSERT INTO matches (round, group_name, match_num, team_a, team_b, match_time, stadium, city, is_knockout, is_locked)
    VALUES (@round, @group_name, @match_num, @team_a, @team_b, @match_time, @stadium, @city, @is_knockout, @is_locked)
  `);

  // Helper – all times in UTC (EDT = UTC-4 during June/July)
  const gm = (num, grp, a, b, utc, stadium, city) => ({
    round: 'group', group_name: grp, match_num: num,
    team_a: a, team_b: b, match_time: utc,
    stadium, city, is_knockout: 0, is_locked: 0
  });
  const km = (round, num, a, b, utc, stadium, city) => ({
    round, group_name: null, match_num: num,
    team_a: a, team_b: b, match_time: utc,
    stadium, city, is_knockout: 1, is_locked: 0
  });

  // ── Official FIFA WC 2026 fixtures ─────────────────────────────────────────
  // Group stage: 72 matches across 12 groups (A–L), ordered chronologically
  // All times stored in UTC. EDT (Jun–Jul) = UTC−4, so 3 PM ET = 19:00 UTC etc.
  const fixtures = [
    // ── GROUP A: 🇲🇽 Mexico · 🇨🇿 Czechia · 🇰🇷 South Korea · 🇿🇦 South Africa ─
    gm( 1,'A','🇲🇽 Mexico',      '🇿🇦 South Africa', '2026-06-11T19:00:00Z', 'Estadio Azteca',          'Mexico City, Mexico'),
    gm( 2,'A','🇰🇷 South Korea', '🇨🇿 Czechia',       '2026-06-12T01:00:00Z', 'Estadio Akron',           'Zapopan, Mexico'),
    gm( 3,'A','🇨🇿 Czechia',     '🇿🇦 South Africa', '2026-06-18T16:00:00Z', 'Mercedes-Benz Stadium',   'Atlanta, GA'),
    gm( 4,'A','🇲🇽 Mexico',      '🇰🇷 South Korea',  '2026-06-19T01:00:00Z', 'Estadio Akron',           'Zapopan, Mexico'),
    gm( 5,'A','🇨🇿 Czechia',     '🇲🇽 Mexico',       '2026-06-25T01:00:00Z', 'Estadio Azteca',          'Mexico City, Mexico'),
    gm( 6,'A','🇿🇦 South Africa','🇰🇷 South Korea',  '2026-06-25T01:00:00Z', 'Estadio BBVA',            'Monterrey, Mexico'),
    // ── GROUP B: 🇨🇦 Canada · 🇨🇭 Switzerland · 🇧🇦 Bosnia & Herz. · 🇶🇦 Qatar ──
    gm( 7,'B','🇨🇦 Canada',      '🇧🇦 Bosnia & Herz.','2026-06-12T19:00:00Z', 'BMO Field',               'Toronto, Canada'),
    gm( 8,'B','🇶🇦 Qatar',       '🇨🇭 Switzerland',  '2026-06-13T19:00:00Z', "Levi's Stadium",          'Santa Clara, CA'),
    gm( 9,'B','🇨🇭 Switzerland', '🇧🇦 Bosnia & Herz.','2026-06-18T19:00:00Z', 'SoFi Stadium',            'Inglewood, CA'),
    gm(10,'B','🇨🇦 Canada',      '🇶🇦 Qatar',         '2026-06-18T22:00:00Z', 'BC Place',                'Vancouver, Canada'),
    gm(11,'B','🇨🇭 Switzerland', '🇨🇦 Canada',        '2026-06-24T19:00:00Z', 'BC Place',                'Vancouver, Canada'),
    gm(12,'B','🇧🇦 Bosnia & Herz.','🇶🇦 Qatar',       '2026-06-24T19:00:00Z', 'Lumen Field',             'Seattle, WA'),
    // ── GROUP C: 🇧🇷 Brazil · 🏴󠁧󠁢󠁳󠁣󠁴󠁿 Scotland · 🇲🇦 Morocco · 🇭🇹 Haiti ────────────
    gm(13,'C','🇧🇷 Brazil',      '🇲🇦 Morocco',       '2026-06-13T22:00:00Z', 'MetLife Stadium',         'East Rutherford, NJ'),
    gm(14,'C','🇭🇹 Haiti',       '🏴󠁧󠁢󠁳󠁣󠁴󠁿 Scotland',    '2026-06-14T01:00:00Z', 'Gillette Stadium',        'Foxborough, MA'),
    gm(15,'C','🏴󠁧󠁢󠁳󠁣󠁴󠁿 Scotland',   '🇲🇦 Morocco',       '2026-06-19T22:00:00Z', 'Gillette Stadium',        'Foxborough, MA'),
    gm(16,'C','🇧🇷 Brazil',      '🇭🇹 Haiti',         '2026-06-20T00:30:00Z', 'Lincoln Financial Field', 'Philadelphia, PA'),
    gm(17,'C','🏴󠁧󠁢󠁳󠁣󠁴󠁿 Scotland',   '🇧🇷 Brazil',        '2026-06-24T22:00:00Z', 'Hard Rock Stadium',       'Miami Gardens, FL'),
    gm(18,'C','🇲🇦 Morocco',     '🇭🇹 Haiti',         '2026-06-24T22:00:00Z', 'Mercedes-Benz Stadium',   'Atlanta, GA'),
    // ── GROUP D: 🇺🇸 USA · 🇦🇺 Australia · 🇹🇷 Türkiye · 🇵🇾 Paraguay ───────────
    gm(19,'D','🇺🇸 USA',         '🇵🇾 Paraguay',      '2026-06-13T01:00:00Z', 'SoFi Stadium',            'Inglewood, CA'),
    gm(20,'D','🇦🇺 Australia',   '🇹🇷 Türkiye',       '2026-06-14T16:00:00Z', 'BC Place',                'Vancouver, Canada'),
    gm(21,'D','🇺🇸 USA',         '🇦🇺 Australia',     '2026-06-19T19:00:00Z', 'Lumen Field',             'Seattle, WA'),
    gm(22,'D','🇹🇷 Türkiye',     '🇵🇾 Paraguay',      '2026-06-20T03:00:00Z', "Levi's Stadium",          'Santa Clara, CA'),
    gm(23,'D','🇹🇷 Türkiye',     '🇺🇸 USA',           '2026-06-26T02:00:00Z', 'SoFi Stadium',            'Inglewood, CA'),
    gm(24,'D','🇵🇾 Paraguay',    '🇦🇺 Australia',     '2026-06-26T02:00:00Z', "Levi's Stadium",          'Santa Clara, CA'),
    // ── GROUP E: 🇩🇪 Germany · 🇨🇮 Ivory Coast · 🇪🇨 Ecuador · 🇨🇼 Curaçao ──────
    gm(25,'E','🇩🇪 Germany',     '🇨🇼 Curaçao',       '2026-06-14T19:00:00Z', 'NRG Stadium',             'Houston, TX'),
    gm(26,'E','🇨🇮 Ivory Coast', '🇪🇨 Ecuador',       '2026-06-15T01:00:00Z', 'Lincoln Financial Field', 'Philadelphia, PA'),
    gm(27,'E','🇩🇪 Germany',     '🇨🇮 Ivory Coast',   '2026-06-20T20:00:00Z', 'BMO Field',               'Toronto, Canada'),
    gm(28,'E','🇪🇨 Ecuador',     '🇨🇼 Curaçao',       '2026-06-21T00:00:00Z', 'Arrowhead Stadium',       'Kansas City, MO'),
    gm(29,'E','🇨🇼 Curaçao',     '🇨🇮 Ivory Coast',   '2026-06-25T20:00:00Z', 'Lincoln Financial Field', 'Philadelphia, PA'),
    gm(30,'E','🇪🇨 Ecuador',     '🇩🇪 Germany',       '2026-06-25T20:00:00Z', 'MetLife Stadium',         'East Rutherford, NJ'),
    // ── GROUP F: 🇳🇱 Netherlands · 🇸🇪 Sweden · 🇯🇵 Japan · 🇹🇳 Tunisia ───────────
    gm(31,'F','🇳🇱 Netherlands', '🇯🇵 Japan',         '2026-06-14T22:00:00Z', 'AT&T Stadium',            'Arlington, TX'),
    gm(32,'F','🇸🇪 Sweden',      '🇹🇳 Tunisia',       '2026-06-15T03:00:00Z', 'Estadio BBVA',            'Monterrey, Mexico'),
    gm(33,'F','🇳🇱 Netherlands', '🇸🇪 Sweden',        '2026-06-20T17:00:00Z', 'NRG Stadium',             'Houston, TX'),
    gm(34,'F','🇹🇳 Tunisia',     '🇯🇵 Japan',         '2026-06-21T04:00:00Z', 'Estadio BBVA',            'Monterrey, Mexico'),
    gm(35,'F','🇯🇵 Japan',       '🇸🇪 Sweden',        '2026-06-25T23:00:00Z', 'AT&T Stadium',            'Arlington, TX'),
    gm(36,'F','🇹🇳 Tunisia',     '🇳🇱 Netherlands',   '2026-06-25T23:00:00Z', 'Arrowhead Stadium',       'Kansas City, MO'),
    // ── GROUP G: 🇧🇪 Belgium · 🇮🇷 Iran · 🇳🇿 New Zealand · 🇪🇬 Egypt ─────────────
    gm(37,'G','🇧🇪 Belgium',     '🇪🇬 Egypt',         '2026-06-15T19:00:00Z', 'Lumen Field',             'Seattle, WA'),
    gm(38,'G','🇮🇷 Iran',        '🇳🇿 New Zealand',   '2026-06-16T01:00:00Z', 'SoFi Stadium',            'Inglewood, CA'),
    gm(39,'G','🇧🇪 Belgium',     '🇮🇷 Iran',          '2026-06-21T19:00:00Z', 'SoFi Stadium',            'Inglewood, CA'),
    gm(40,'G','🇳🇿 New Zealand', '🇪🇬 Egypt',         '2026-06-22T01:00:00Z', 'BC Place',                'Vancouver, Canada'),
    gm(41,'G','🇪🇬 Egypt',       '🇮🇷 Iran',          '2026-06-27T03:00:00Z', 'Lumen Field',             'Seattle, WA'),
    gm(42,'G','🇳🇿 New Zealand', '🇧🇪 Belgium',       '2026-06-27T03:00:00Z', 'BC Place',                'Vancouver, Canada'),
    // ── GROUP H: 🇪🇸 Spain · 🇸🇦 Saudi Arabia · 🇺🇾 Uruguay · 🇨🇻 Cape Verde ──────
    gm(43,'H','🇪🇸 Spain',       '🇨🇻 Cape Verde',    '2026-06-15T16:00:00Z', 'Mercedes-Benz Stadium',   'Atlanta, GA'),
    gm(44,'H','🇸🇦 Saudi Arabia','🇺🇾 Uruguay',        '2026-06-15T22:00:00Z', 'Hard Rock Stadium',       'Miami Gardens, FL'),
    gm(45,'H','🇪🇸 Spain',       '🇸🇦 Saudi Arabia',  '2026-06-21T16:00:00Z', 'Mercedes-Benz Stadium',   'Atlanta, GA'),
    gm(46,'H','🇺🇾 Uruguay',     '🇨🇻 Cape Verde',    '2026-06-21T22:00:00Z', 'Hard Rock Stadium',       'Miami Gardens, FL'),
    gm(47,'H','🇨🇻 Cape Verde',  '🇸🇦 Saudi Arabia',  '2026-06-27T00:00:00Z', 'NRG Stadium',             'Houston, TX'),
    gm(48,'H','🇺🇾 Uruguay',     '🇪🇸 Spain',         '2026-06-27T00:00:00Z', 'Estadio Akron',           'Zapopan, Mexico'),
    // ── GROUP I: 🇫🇷 France · 🇳🇴 Norway · 🇸🇳 Senegal · 🇮🇶 Iraq ────────────────
    gm(49,'I','🇫🇷 France',      '🇸🇳 Senegal',       '2026-06-16T19:00:00Z', 'MetLife Stadium',         'East Rutherford, NJ'),
    gm(50,'I','🇮🇶 Iraq',        '🇳🇴 Norway',        '2026-06-16T22:00:00Z', 'Gillette Stadium',        'Foxborough, MA'),
    gm(51,'I','🇫🇷 France',      '🇮🇶 Iraq',          '2026-06-22T21:00:00Z', 'Lincoln Financial Field', 'Philadelphia, PA'),
    gm(52,'I','🇳🇴 Norway',      '🇸🇳 Senegal',       '2026-06-23T00:00:00Z', 'MetLife Stadium',         'East Rutherford, NJ'),
    gm(53,'I','🇳🇴 Norway',      '🇫🇷 France',        '2026-06-26T19:00:00Z', 'Gillette Stadium',        'Foxborough, MA'),
    gm(54,'I','🇸🇳 Senegal',     '🇮🇶 Iraq',          '2026-06-26T19:00:00Z', 'BMO Field',               'Toronto, Canada'),
    // ── GROUP J: 🇦🇷 Argentina · 🇦🇹 Austria · 🇯🇴 Jordan · 🇩🇿 Algeria ──────────
    gm(55,'J','🇦🇷 Argentina',   '🇩🇿 Algeria',       '2026-06-17T01:00:00Z', 'Arrowhead Stadium',       'Kansas City, MO'),
    gm(56,'J','🇦🇹 Austria',     '🇯🇴 Jordan',        '2026-06-17T16:00:00Z', "Levi's Stadium",          'Santa Clara, CA'),
    gm(57,'J','🇦🇷 Argentina',   '🇦🇹 Austria',       '2026-06-22T17:00:00Z', 'AT&T Stadium',            'Arlington, TX'),
    gm(58,'J','🇯🇴 Jordan',      '🇩🇿 Algeria',       '2026-06-23T03:00:00Z', "Levi's Stadium",          'Santa Clara, CA'),
    gm(59,'J','🇩🇿 Algeria',     '🇦🇹 Austria',       '2026-06-28T02:00:00Z', 'Arrowhead Stadium',       'Kansas City, MO'),
    gm(60,'J','🇯🇴 Jordan',      '🇦🇷 Argentina',     '2026-06-28T02:00:00Z', 'AT&T Stadium',            'Arlington, TX'),
    // ── GROUP K: 🇵🇹 Portugal · 🇨🇴 Colombia · 🇺🇿 Uzbekistan · 🇨🇩 DR Congo ──────
    gm(61,'K','🇵🇹 Portugal',    '🇨🇩 DR Congo',      '2026-06-17T19:00:00Z', 'NRG Stadium',             'Houston, TX'),
    gm(62,'K','🇺🇿 Uzbekistan',  '🇨🇴 Colombia',      '2026-06-18T03:00:00Z', 'Estadio Azteca',          'Mexico City, Mexico'),
    gm(63,'K','🇵🇹 Portugal',    '🇺🇿 Uzbekistan',    '2026-06-23T17:00:00Z', 'NRG Stadium',             'Houston, TX'),
    gm(64,'K','🇨🇴 Colombia',    '🇨🇩 DR Congo',      '2026-06-24T02:00:00Z', 'Estadio Akron',           'Zapopan, Mexico'),
    gm(65,'K','🇨🇴 Colombia',    '🇵🇹 Portugal',      '2026-06-27T23:30:00Z', 'Hard Rock Stadium',       'Miami Gardens, FL'),
    gm(66,'K','🇨🇩 DR Congo',    '🇺🇿 Uzbekistan',    '2026-06-27T23:30:00Z', 'Mercedes-Benz Stadium',   'Atlanta, GA'),
    // ── GROUP L: 🏴󠁧󠁢󠁥󠁮󠁧󠁿 England · 🇭🇷 Croatia · 🇬🇭 Ghana · 🇵🇦 Panama ─────────────
    gm(67,'L','🏴󠁧󠁢󠁥󠁮󠁧󠁿 England',    '🇭🇷 Croatia',       '2026-06-17T22:00:00Z', 'AT&T Stadium',            'Arlington, TX'),
    gm(68,'L','🇬🇭 Ghana',       '🇵🇦 Panama',        '2026-06-18T01:00:00Z', 'BMO Field',               'Toronto, Canada'),
    gm(69,'L','🏴󠁧󠁢󠁥󠁮󠁧󠁿 England',    '🇬🇭 Ghana',         '2026-06-23T20:00:00Z', 'Gillette Stadium',        'Foxborough, MA'),
    gm(70,'L','🇵🇦 Panama',      '🇭🇷 Croatia',       '2026-06-23T23:00:00Z', 'BMO Field',               'Toronto, Canada'),
    gm(71,'L','🇵🇦 Panama',      '🏴󠁧󠁢󠁥󠁮󠁧󠁿 England',     '2026-06-27T21:00:00Z', 'MetLife Stadium',         'East Rutherford, NJ'),
    gm(72,'L','🇭🇷 Croatia',     '🇬🇭 Ghana',         '2026-06-27T21:00:00Z', 'Lincoln Financial Field', 'Philadelphia, PA'),

    // ── Round of 32 (June 28 – July 3) ────────────────────────────────────────
    km('r32', 1,'Runner-up A',    'Runner-up B',   '2026-06-28T19:00:00Z', 'SoFi Stadium',            'Inglewood, CA'),
    km('r32', 2,'Winner C',       'Runner-up F',   '2026-06-29T17:00:00Z', 'NRG Stadium',             'Houston, TX'),
    km('r32', 3,'Winner E',       'Best 3rd ABCDF','2026-06-29T20:30:00Z', 'Gillette Stadium',        'Foxborough, MA'),
    km('r32', 4,'Winner F',       'Runner-up C',   '2026-06-30T01:00:00Z', 'Estadio BBVA',            'Monterrey, Mexico'),
    km('r32', 5,'Runner-up E',    'Runner-up I',   '2026-06-30T17:00:00Z', 'AT&T Stadium',            'Arlington, TX'),
    km('r32', 6,'Winner I',       'Best 3rd CDFGH','2026-06-30T21:00:00Z', 'MetLife Stadium',         'East Rutherford, NJ'),
    km('r32', 7,'Winner A',       'Best 3rd CEFHI','2026-07-01T01:00:00Z', 'Estadio Azteca',          'Mexico City, Mexico'),
    km('r32', 8,'Winner L',       'Best 3rd EHIJK','2026-07-01T16:00:00Z', 'Mercedes-Benz Stadium',   'Atlanta, GA'),
    km('r32', 9,'Winner G',       'Best 3rd AEHIJ','2026-07-01T20:00:00Z', 'Lumen Field',             'Seattle, WA'),
    km('r32',10,'Winner D',       'Best 3rd BEFIJ','2026-07-02T00:00:00Z', "Levi's Stadium",          'Santa Clara, CA'),
    km('r32',11,'Winner H',       'Runner-up J',   '2026-07-02T19:00:00Z', 'SoFi Stadium',            'Inglewood, CA'),
    km('r32',12,'Runner-up K',    'Runner-up L',   '2026-07-02T23:00:00Z', 'BMO Field',               'Toronto, Canada'),
    km('r32',13,'Winner B',       'Best 3rd EFGIJ','2026-07-03T03:00:00Z', 'BC Place',                'Vancouver, Canada'),
    km('r32',14,'Runner-up D',    'Runner-up G',   '2026-07-03T18:00:00Z', 'AT&T Stadium',            'Arlington, TX'),
    km('r32',15,'Winner J',       'Runner-up H',   '2026-07-03T22:00:00Z', 'Hard Rock Stadium',       'Miami Gardens, FL'),
    km('r32',16,'Winner K',       'Best 3rd DEIJL','2026-07-04T01:30:00Z', 'Arrowhead Stadium',       'Kansas City, MO'),

    // ── Round of 16 (July 4 – 7) ──────────────────────────────────────────────
    km('r16', 1,'R32 Winner 1',   'R32 Winner 2',  '2026-07-04T17:00:00Z', 'NRG Stadium',             'Houston, TX'),
    km('r16', 2,'R32 Winner 3',   'R32 Winner 4',  '2026-07-04T21:00:00Z', 'Lincoln Financial Field', 'Philadelphia, PA'),
    km('r16', 3,'R32 Winner 5',   'R32 Winner 6',  '2026-07-05T20:00:00Z', 'MetLife Stadium',         'East Rutherford, NJ'),
    km('r16', 4,'R32 Winner 7',   'R32 Winner 8',  '2026-07-06T00:00:00Z', 'Estadio Azteca',          'Mexico City, Mexico'),
    km('r16', 5,'R32 Winner 9',   'R32 Winner 10', '2026-07-06T19:00:00Z', 'AT&T Stadium',            'Arlington, TX'),
    km('r16', 6,'R32 Winner 11',  'R32 Winner 12', '2026-07-07T00:00:00Z', 'Lumen Field',             'Seattle, WA'),
    km('r16', 7,'R32 Winner 13',  'R32 Winner 14', '2026-07-07T16:00:00Z', 'Mercedes-Benz Stadium',   'Atlanta, GA'),
    km('r16', 8,'R32 Winner 15',  'R32 Winner 16', '2026-07-07T20:00:00Z', 'BC Place',                'Vancouver, Canada'),

    // ── Quarter-finals (July 9 – 11) ──────────────────────────────────────────
    km('qf',  1,'R16 Winner 1',   'R16 Winner 2',  '2026-07-09T20:00:00Z', 'Gillette Stadium',        'Foxborough, MA'),
    km('qf',  2,'R16 Winner 3',   'R16 Winner 4',  '2026-07-10T19:00:00Z', 'SoFi Stadium',            'Inglewood, CA'),
    km('qf',  3,'R16 Winner 5',   'R16 Winner 6',  '2026-07-11T21:00:00Z', 'Hard Rock Stadium',       'Miami Gardens, FL'),
    km('qf',  4,'R16 Winner 7',   'R16 Winner 8',  '2026-07-12T01:00:00Z', 'Arrowhead Stadium',       'Kansas City, MO'),

    // ── Semi-finals (July 14 – 15) ────────────────────────────────────────────
    km('sf',  1,'QF Winner 1',    'QF Winner 2',   '2026-07-14T19:00:00Z', 'AT&T Stadium',            'Arlington, TX'),
    km('sf',  2,'QF Winner 3',    'QF Winner 4',   '2026-07-15T19:00:00Z', 'Mercedes-Benz Stadium',   'Atlanta, GA'),

    // ── Third-place match (July 18) ────────────────────────────────────────────
    km('3rd', 1,'SF Loser 1',     'SF Loser 2',    '2026-07-18T21:00:00Z', 'Hard Rock Stadium',       'Miami Gardens, FL'),

    // ── Final (July 19) ───────────────────────────────────────────────────────
    km('final',1,'SF Winner 1',   'SF Winner 2',   '2026-07-19T19:00:00Z', 'MetLife Stadium',         'East Rutherford, NJ'),
  ];

  const seedTx = db.transaction(() => {
    fixtures.forEach(f => ins.run(f));
  });
  seedTx();
  console.log(`✅ WC 2026 fixtures seeded: ${fixtures.length} matches`);
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
  const resultMap = {};
  results.forEach(r => { resultMap[r.match_id] = r; });

  const matchMap = {};
  matches.forEach(m => { matchMap[m.id] = m; });

  const predMap = {};
  predictions.forEach(p => {
    if (!predMap[p.user_id]) predMap[p.user_id] = {};
    predMap[p.user_id][p.match_id] = p;
  });

  const rows = users.map(u => {
    let groupPts = 0, knockoutPts = 0, bonusPts = 0, correct = 0;
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

    return {
      id: u.id,
      username: u.username,
      display_name: u.display_name || u.username,
      group_pts: groupPts,
      knockout_pts: knockoutPts,
      bonus_pts: bonusPts,
      total: groupPts + knockoutPts + bonusPts,
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
  return d.toLocaleString('en-US', {
    timeZone: 'Asia/Kuwait',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

function toKuwaitTimeShort(utcDateStr) {
  const d = new Date(utcDateStr);
  return d.toLocaleString('en-US', {
    timeZone: 'Asia/Kuwait',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

module.exports = { getDb, calculateMatchPoints, computeLeaderboard, toKuwaitTime, toKuwaitTimeShort, ROUND_POINTS };
