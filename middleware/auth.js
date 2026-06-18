function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  req.session.flashError = 'Please log in to continue.';
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.is_admin) return next();
  req.session.flashError = 'Admin access required.';
  res.redirect('/dashboard');
}

module.exports = { requireLogin, requireAdmin };
