/**
 * seed-users.js
 * Run once from terminal: node seed-users.js
 * Creates all 17 users and their Match 1-24 predictions.
 */

try { require('dotenv').config(); } catch(e) {}
const path   = require('path');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const DB_DIR  = process.env.DB_PATH || path.join(__dirname, 'db');
const DB_PATH = path.join(DB_DIR, 'wc2026.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── User data from Excel ──────────────────────────────────────────────────────
// Predictions: team name string | 'Draw'
// Match order = first 24 group games chronologically (time-ordered)
const USERS = [
  { name: 'Abdulaziz Aljanahi',   username: 'Aljanahi',   password: '1122', preds: ['Mexico','South Korea','Bosnia','Paraguay','Qatar','Morocco','Scotland','Turkey','Germany','Netherlands','Ecuador','Tunisia','Spain','Egypt','Uruguay','Iran','Senegal','Iraq','Algeria','Jordan','Portugal','Croatia','Ghana','Uzbekistan'] },
  { name: 'Abdulaziz Alshabaan',  username: 'Alshabaan',  password: '2233', preds: ['Draw','South Korea','Bosnia','USA','Switzerland','Brazil','Scotland','Turkey','Germany','Netherlands','Ecuador','Sweden','Spain','Belgium','Uruguay','New Zealand','France','Norway','Argentina','Jordan','Portugal','Draw','Ghana','Columbia'] },
  { name: 'Abdulaziz Alyaseen',   username: 'Alyaseen',   password: '3344', preds: ['Mexico','Draw','Canada','USA','Switzerland','Morocco','Scotland','Draw','Germany','Netherlands','Ecuador','Sweden','Spain','Belgium','Uruguay','Iran','France','Norway','Argentina','Austria','Portugal','England','Draw','Columbia'] },
  { name: 'Abdulwahab Alghanim',  username: 'Alghanim',   password: '4455', preds: ['Mexico','Draw','Draw','USA','Switzerland','Draw','Scotland','Turkey','Germany','Netherlands','Ecuador','Tunisia','Spain','Draw','Draw','Iran','France','Norway','Argentina','Austria','Portugal','England','Ghana','Columbia'] },
  { name: 'Barjas Albarjas',      username: 'Albarjas',   password: '5566', preds: ['Mexico','Draw','Canada','USA','Switzerland','Brazil','Scotland','Turkey','Germany','Netherlands','Ivory Coast','Sweden','Spain','Belgium','Uruguay','Iran','France','Norway','Argentina','Austria','Portugal','England','Ghana','Columbia'] },
  { name: 'Eid Almeshwat',        username: 'Almeshwat',  password: '6677', preds: ['Mexico','South Korea','Canada','USA','Switzerland','Brazil','Scotland','Australia','Germany','Netherlands','Ecuador','Sweden','Spain','Belgium','Uruguay','New Zealand','France','Norway','Argentina','Austria','Portugal','England','Ghana','Columbia'] },
  { name: 'Fahad Alfulaij',       username: 'Alfulaij',   password: '7788', preds: ['Mexico','Draw','Canada','USA','Switzerland','Brazil','Draw','Australia','Germany','Netherlands','Ecuador','Sweden','Spain','Belgium','Uruguay','Draw','France','Norway','Argentina','Draw','Portugal','Croatia','Ghana','Columbia'] },
  { name: 'Fahad Algashaan',      username: 'Algashaan',  password: '8899', preds: ['Mexico','South Korea','Canada','USA','Switzerland','Morocco','Scotland','Draw','Germany','Draw','Ivory Coast','Tunisia','Spain','Egypt','Draw','Iran','France','Norway','Argentina','Jordan','Portugal','England','Ghana','Columbia'] },
  { name: 'Hamad Almubarak',      username: 'Almubarak',  password: '9900', preds: ['Mexico','South Korea','Bosnia','USA','Switzerland','Brazil','Scotland','Turkey','Germany','Japan','Ivory Coast','Sweden','Spain','Belgium','Saudi Arabia','Iran','France','Norway','Argentina','Austria','Portugal','England','Ghana','Columbia'] },
  { name: 'Hamad Almudhaf',       username: 'Halmudhaf',  password: '1234', preds: ['Mexico','Draw','Canada','Draw','Switzerland','Brazil','Draw','Turkey','Germany','Netherlands','Draw','Draw','Spain','Draw','Uruguay','Draw','France','Norway','Draw','Draw','Portugal','Draw','Draw','Columbia'] },
  { name: 'Khaled Almudhaf',      username: 'Kalmudhaf',  password: '5678', preds: ['Mexico','Czechia','Bosnia','Draw','Switzerland','Brazil','Scotland','Turkey','Germany','Netherlands','Ecuador','Sweden','Spain','Belgium','Uruguay','New Zealand','France','Norway','Draw','Austria','Portugal','Draw','Ghana','Columbia'] },
  { name: 'Mohammed Alajran',     username: 'Alajran',    password: '4321', preds: ['Mexico','Draw','Canada','Paraguay','Switzerland','Brazil','Scotland','Turkey','Germany','Netherlands','Draw','Tunisia','Spain','Egypt','Saudi Arabia','Draw','France','Norway','Argentina','Austria','Portugal','England','Draw','Draw'] },
  { name: 'Mohammed Albargash',   username: 'Albargash',  password: '8765', preds: ['Mexico','South Korea','Canada','Paraguay','Qatar','Brazil','Scotland','Turkey','Germany','Japan','Ecuador','Tunisia','Spain','Belgium','Saudi Arabia','Iran','France','Norway','Argentina','Austria','Portugal','England','Ghana','Columbia'] },
  { name: 'Musaad Almajdeli',     username: 'Malmajdeli', password: '2211', preds: ['Mexico','Draw','Bosnia','Paraguay','Switzerland','Draw','Scotland','Turkey','Germany','Draw','Ivory Coast','Draw','Spain','Belgium','Uruguay','Draw','Draw','Draw','Draw','Draw','Portugal','England','Ghana','Columbia'] },
  { name: 'Sager Alameeri',       username: 'Alameeri',   password: '3322', preds: ['Mexico','Draw','Draw','USA','Switzerland','Brazil','Scotland','Turkey','Germany','Netherlands','Ivory Coast','Sweden','Spain','Belgium','Uruguay','Draw','France','Norway','Argentina','Jordan','Portugal','England','Ghana','Columbia'] },
  { name: 'Saoud Almajdeli',      username: 'Salmajdeli', password: '4433', preds: ['Mexico','Czechia','Canada','USA','Switzerland','Draw','Scotland','Turkey','Germany','Draw','Ecuador','Sweden','Spain','Belgium','Uruguay','Draw','France','Norway','Argentina','Austria','Portugal','Draw','Draw','Columbia'] },
  { name: 'Talal Almurjan',       username: 'Almurjan',   password: '5544', preds: ['Mexico','South Korea','Draw','Draw','Switzerland','Brazil','Scotland','Turkey','Germany','Draw','Draw','Sweden','Spain','Belgium','Uruguay','Iran','France','Norway','Argentina','Draw','Portugal','Draw','Draw','Columbia'] },
];

// ── Team name normalizer: strips emojis + whitespace, lowercases ──────────────
function normTeam(s) {
  return s
    .replace(/[\u{1F1E0}-\u{1F1FF}\u{1F3F4}\u{1F3F3}]/gu, '') // flag emojis
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Aliases for common mismatches
const ALIASES = {
  'turkey':   'türkiye',
  'columbia': 'colombia',
  'bosnia':   'bosnia & herz.',
  'ivory coast': 'ivory coast',
};

function resolveAlias(pred) {
  const lc = pred.toLowerCase();
  return ALIASES[lc] || lc;
}

// ── Get first 24 group matches by time order ──────────────────────────────────
const matches24 = db.prepare(
  "SELECT id, team_a, team_b FROM matches WHERE round='group' ORDER BY match_time, id LIMIT 24"
).all();

if (matches24.length < 24) {
  console.error(`❌ Only ${matches24.length} group matches found — run the app first to seed the DB.`);
  process.exit(1);
}

console.log('\n📋 First 24 matches (chronological):');
matches24.forEach((m, i) => {
  console.log(`  ${String(i+1).padStart(2)}. [${m.id}] ${m.team_a} vs ${m.team_b}`);
});

// ── Prediction mapper ─────────────────────────────────────────────────────────
function mapPrediction(predText, match) {
  if (!predText || predText.trim().toLowerCase() === 'draw') return 'draw';

  const pred = resolveAlias(predText.trim());
  const normA = normTeam(match.team_a);
  const normB = normTeam(match.team_b);

  // Exact or contains match
  if (normA.includes(pred) || pred.includes(normA)) return 'team_a';
  if (normB.includes(pred) || pred.includes(normB)) return 'team_b';

  console.warn(`  ⚠️  Could not map "${predText}" to either team in "${match.team_a}" vs "${match.team_b}" — defaulting to draw`);
  return null; // skip this prediction
}

// ── Prepared statements ───────────────────────────────────────────────────────
const findUser    = db.prepare('SELECT id FROM users WHERE username = ?');
const insertUser  = db.prepare(
  'INSERT INTO users (username, display_name, password_hash, is_admin) VALUES (?, ?, ?, 0)'
);
const upsertPred  = db.prepare(`
  INSERT INTO predictions (user_id, match_id, prediction, aet_prediction, updated_at)
  VALUES (?, ?, ?, NULL, CURRENT_TIMESTAMP)
  ON CONFLICT (user_id, match_id) DO UPDATE SET
    prediction     = excluded.prediction,
    aet_prediction = NULL,
    updated_at     = CURRENT_TIMESTAMP
`);

// ── Main seed ─────────────────────────────────────────────────────────────────
let createdUsers = 0, skippedUsers = 0, totalPreds = 0;

const seedAll = db.transaction(() => {
  for (const u of USERS) {
    // Create user (skip if already exists)
    let existing = findUser.get(u.username);
    if (existing) {
      console.log(`  ℹ️  User "${u.username}" already exists — skipping user creation`);
      skippedUsers++;
    } else {
      const hash = bcrypt.hashSync(String(u.password), 10);
      const info = insertUser.run(u.username, u.name, hash);
      existing = { id: info.lastInsertRowid };
      console.log(`  ✅ Created user: ${u.username} (${u.name})`);
      createdUsers++;
    }

    const userId = existing.id;

    // Insert predictions
    u.preds.forEach((predText, i) => {
      const match = matches24[i];
      const pred  = mapPrediction(predText, match);
      if (pred) {
        upsertPred.run(userId, match.id, pred);
        totalPreds++;
      }
    });
  }
});

console.log('\n🔄 Seeding users and predictions...\n');
seedAll();

console.log(`\n✅ Done!`);
console.log(`   Users created : ${createdUsers}`);
console.log(`   Users skipped : ${skippedUsers} (already existed)`);
console.log(`   Predictions   : ${totalPreds}`);
console.log('\nRun this script again safely — it will skip existing users and upsert predictions.\n');
