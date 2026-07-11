(function () {
  const API = '/.netlify/functions/auth';
  const state = { authenticated: false };
  window.AUTH429 = {
    state,
    async me() {
      try { state.authenticated = !!(await (await fetch(`${API}?route=me`, { cache: 'no-store' })).json()).authenticated; }
      catch (_) { state.authenticated = false; }
      return state.authenticated;
    },
    async privateData() {
      const res = await fetch(`${API}?route=data`, { cache: 'no-store' });
      if (!res.ok) throw new Error('login required');
      return res.json();
    },
    async privateReport(period) {
      const res = await fetch(`${API}?route=report&period=${encodeURIComponent(period)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('login required');
      return res.json();
    },
  };

  function mount() {
    if (document.getElementById('auth429-button')) return;
    const nav = document.querySelector('.topnav, .navlinks');
    if (!nav) return;
    const btn = document.createElement('button');
    btn.id = 'auth429-button';
    btn.className = 'theme-toggle auth-button';
    btn.type = 'button';
    btn.textContent = state.authenticated ? 'Logout' : 'Owner Login';
    btn.addEventListener('click', () => state.authenticated ? logout() : showLogin());
    nav.appendChild(btn);
  }
  async function refresh() { await window.AUTH429.me(); mount(); const b = document.getElementById('auth429-button'); if (b) b.textContent = state.authenticated ? 'Logout' : 'Owner Login'; }
  async function logout() { await fetch(`${API}?route=logout`, { method: 'POST' }); location.reload(); }
  function showLogin() {
    const overlay = document.createElement('div');
    overlay.className = 'auth-modal';
    overlay.innerHTML = `<form class="auth-card"><button type="button" class="auth-x" aria-label="Close">×</button><div class="side-label">Owner access</div><h2>Unlock dollar values</h2><p>Public visitors only see percentages and positioning. Login loads the private marked values from a server-side endpoint.</p><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="btn" type="submit">Login</button><p class="auth-error" role="alert"></p></form>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.auth-x').onclick = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const error = overlay.querySelector('.auth-error'); error.textContent = '';
      const body = Object.fromEntries(new FormData(e.currentTarget).entries());
      const res = await fetch(`${API}?route=login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) location.reload();
      else error.textContent = ((await res.json().catch(() => ({}))).error || 'Login failed.');
    });
  }
  document.addEventListener('DOMContentLoaded', refresh);
})();
