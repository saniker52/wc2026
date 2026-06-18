const express = require('express');
const { getDb } = require('../db/database');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

// GET /awards
router.get('/', requireLogin, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;

  const categories = db.prepare('SELECT * FROM award_categories ORDER BY sort_order').all();

  const enriched = categories.map(cat => {
    const options = db.prepare('SELECT * FROM award_options WHERE category_id = ? ORDER BY name').all(cat.id);
    const prediction = db.prepare('SELECT * FROM award_predictions WHERE user_id = ? AND category_id = ?').get(userId, cat.id);
    const winner = cat.winner_option_id ? db.prepare('SELECT name FROM award_options WHERE id = ?').get(cat.winner_option_id) : null;

    return { ...cat, options, prediction, winner };
  });

  res.render('awards', { title: 'Tournament Award Predictions', categories: enriched });
});

// POST /awards/:categoryId/predict
router.post('/:categoryId/predict', requireLogin, (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const categoryId = parseInt(req.params.categoryId);
  const { option_id } = req.body;

  const cat = db.prepare('SELECT * FROM award_categories WHERE id = ?').get(categoryId);
  if (!cat) {
    req.session.flashError = 'Category not found.';
    return res.redirect('/awards');
  }
  if (cat.is_locked) {
    req.session.flashError = 'Award predictions are locked.';
    return res.redirect('/awards');
  }

  const option = db.prepare('SELECT * FROM award_options WHERE id = ? AND category_id = ?').get(parseInt(option_id), categoryId);
  if (!option) {
    req.session.flashError = 'Invalid selection.';
    return res.redirect('/awards');
  }

  db.prepare(`
    INSERT INTO award_predictions (user_id, category_id, option_id)
    VALUES (?, ?, ?)
    ON CONFLICT (user_id, category_id) DO UPDATE SET option_id = excluded.option_id, submitted_at = CURRENT_TIMESTAMP
  `).run(userId, categoryId, option.id);

  req.session.flashSuccess = `✅ Prediction saved for "${cat.name}"!`;
  res.redirect('/awards');
});

module.exports = router;
