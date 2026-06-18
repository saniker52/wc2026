const express = require('express');
const { getDb, computeLeaderboard } = require('../db/database');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const db = getDb();
  const { filter } = req.query; // 'overall' | 'group' | 'knockout' | 'awards'

  const all = computeLeaderboard(db);

  let rows = all;
  if (filter === 'group') {
    rows = all.map(r => ({ ...r, display_total: r.group_pts }))
      .sort((a, b) => b.group_pts - a.group_pts)
      .map((r, i) => ({ ...r, rank: i + 1 }));
  } else if (filter === 'knockout') {
    rows = all.map(r => ({ ...r, display_total: r.knockout_pts + r.bonus_pts }))
      .sort((a, b) => (b.knockout_pts + b.bonus_pts) - (a.knockout_pts + a.bonus_pts))
      .map((r, i) => ({ ...r, rank: i + 1 }));
  } else {
    rows = all.map(r => ({ ...r, display_total: r.total }));
  }

  const myId = req.session.user.id;

  res.render('leaderboard', {
    title: 'Leaderboard',
    rows,
    filter: filter || 'overall',
    myId,
    updatedAt: new Date().toLocaleString('en-KW', { timeZone: 'Asia/Kuwait' })
  });
});

module.exports = router;
