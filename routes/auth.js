const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');

const router = express.Router();

// GET /login
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { title: 'Login – WC2026 Predictions' });
});

// POST /login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    req.session.flashError = 'Please enter your username and password.';
    return res.redirect('/login');
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    req.session.flashError = 'Invalid username or password.';
    return res.redirect('/login');
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    display_name: user.display_name || user.username,
    is_admin: user.is_admin === 1
  };

  req.session.flashSuccess = `Welcome back, ${user.display_name || user.username}! ⚽`;
  res.redirect(user.is_admin ? '/admin' : '/dashboard');
});

// GET /logout
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// GET /change-password
router.get('/change-password', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.render('change-password', { title: 'Change Password' });
});

// POST /change-password
router.post('/change-password', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const { current_password, new_password, confirm_password } = req.body;

  if (!current_password || !new_password || !confirm_password) {
    req.session.flashError = 'All fields are required.';
    return res.redirect('/change-password');
  }
  if (new_password !== confirm_password) {
    req.session.flashError = 'New passwords do not match.';
    return res.redirect('/change-password');
  }
  if (new_password.length < 6) {
    req.session.flashError = 'New password must be at least 6 characters.';
    return res.redirect('/change-password');
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    req.session.flashError = 'Current password is incorrect.';
    return res.redirect('/change-password');
  }

  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.session.user.id);
  req.session.flashSuccess = 'Password changed successfully.';
  res.redirect('/dashboard');
});

module.exports = router;
