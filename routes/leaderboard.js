const express = require('express');
const { getDb, computeLeaderboard } = require('../db/database');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

// Prize pool by position (1-indexed)
const PRIZE_POOL = [200, 80, 50];

function computePrizes(rows) {
  const prizeMap = {};
  const byRank = {};
  rows.forEach(r => {
    if (!byRank[r.rank]) byRank[r.rank] = [];
    byRank[r.rank].push(r.id);
  });
  for (const [rankStr, ids] of Object.entries(byRank)) {
    const startPos = parseInt(rankStr);
    let totalPrize = 0;
    for (let pos = startPos; pos < startPos + ids.length; pos++) {
      if (pos <= PRIZE_POOL.length) totalPrize += PRIZE_POOL[pos - 1];
    }
    if (totalPrize > 0) {
      ids.forEach(id => { prizeMap[id] = totalPrize / ids.length; });
    }
  }
  return prizeMap;
}

router.get('/', requireLogin, (req, res) => {
  const db = getDb();
  const all = computeLeaderboard(db);
  const myId = req.session.user.id;
  const prizeMap = computePrizes(all);
  const rows = all.map(r => ({ ...r, prize: prizeMap[r.id] || null }));

  const now = new Date().toISOString();
  const koStarted = db.prepare("SELECT id FROM matches WHERE round != 'group' AND match_time <= ? LIMIT 1").get(now);
  const currentStage = koStarted ? 'ko' : 'group';

  res.render('leaderboard', {
    title: 'Leaderboard',
    rows,
    myId,
    currentStage,
    updatedAt: new Date().toLocaleString('en-KW', { timeZone: 'Asia/Kuwait' })
  });
});

module.exports = router;
