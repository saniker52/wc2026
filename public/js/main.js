// ── Auto-dismiss flash messages after 5s ───────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const flashes = document.querySelectorAll('.flash');
  flashes.forEach(el => {
    setTimeout(() => {
      el.style.transition = 'opacity .5s ease, transform .5s ease';
      el.style.opacity = '0';
      el.style.transform = 'translateY(-8px)';
      setTimeout(() => el.remove(), 500);
    }, 5000);
  });

  // ── Confirm dangerous forms ─────────────────────────────────────────────────
  document.querySelectorAll('form[data-confirm]').forEach(form => {
    form.addEventListener('submit', e => {
      if (!confirm(form.dataset.confirm)) e.preventDefault();
    });
  });

  // ── Knockout: disable draw option when knockout radio picked ─────────────────
  const predForm = document.getElementById('predictForm');
  if (predForm) {
    const drawOpt = predForm.querySelector('input[value="draw"]');
    // Draw is already hidden in the template for knockout; this is a safety guard
  }

  // ── Prediction option highlight on keyboard ───────────────────────────────────
  document.querySelectorAll('.predict-option input[type="radio"]').forEach(radio => {
    radio.addEventListener('change', () => {
      document.querySelectorAll('.predict-option label').forEach(l => l.style.transform = '');
      const label = radio.nextElementSibling;
      if (radio.checked && label) label.style.transform = 'scale(1.02)';
    });
  });

  // ── Leaderboard row highlight for current user ────────────────────────────────
  const myRow = document.querySelector('.leaderboard-table .me');
  if (myRow) {
    myRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
});

// ── Navbar close on outside click (mobile) ────────────────────────────────────
document.addEventListener('click', (e) => {
  const menu = document.querySelector('.navbar-menu');
  const toggle = document.querySelector('.navbar-toggle');
  if (menu && toggle && menu.classList.contains('open')) {
    if (!menu.contains(e.target) && !toggle.contains(e.target)) {
      menu.classList.remove('open');
    }
  }
});
