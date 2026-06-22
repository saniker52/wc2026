const express = require('express');
const { getDb, computeLeaderboard } = require('../db/database');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const db = getDb();
  const all = computeLeaderboard(db);
  const rows = all.map(r => ({ ...r, display_total: r.total }));
  const myId = req.session.user.id;

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
