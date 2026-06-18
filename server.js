try { require('dotenv').config(); } catch(e) {}
const express = require('express');
const session = require('express-session');
const methodOverride = require('method-override');
const path = require('path');
const SQLiteStore = require('connect-sqlite3')(session);

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);

// ── View engine ───────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

// ── Sessions ──────────────────────────────────────────────────────────────────
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: process.env.DB_PATH || path.join(__dirname, 'db') }),
  secret: process.env.SESSION_SECRET || 'wc2026-super-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
  }
}));

// ── Global template locals ────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.flashSuccess = req.session.flashSuccess || null;
  res.locals.flashError = req.session.flashError || null;
  delete req.session.flashSuccess;
  delete req.session.flashError;
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/user'));
app.use('/leaderboard', require('./routes/leaderboard'));
app.use('/admin', require('./routes/admin'));

// ── Root redirect ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.redirect('/login');
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('error', { title: '404 – Page Not Found', message: 'That page does not exist.' });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', { title: 'Server Error', message: 'Something went wrong. Please try again.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`⚽ WC2026 Predictions running on http://localhost:${PORT}`);
  console.log(`   Admin login: admin / admin123 (change after first login!)`);
});
