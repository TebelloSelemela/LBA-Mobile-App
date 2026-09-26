import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Download, FileText, Lock, Plus, RefreshCw, Search, Shuffle, Trash2, Trophy, Upload, Users, Home, Menu, X, Sun, Moon, ShieldCheck, CalendarDays, CheckCircle2, ClipboardList, MonitorPlay, Maximize, Minimize } from 'lucide-react';
import './style.css';
import logo from './assets/lba-logo.png';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:5050/api';

function getToken() {
  return sessionStorage.getItem('lba_token') || '';
}

// Authentication is intentionally session-only. A fresh app session must require login.
localStorage.removeItem('lba_token');
localStorage.removeItem('lba_user');

async function saveBlob(blob, filename) {
  if (window.Capacitor?.isNativePlatform?.()) {
    const buffer = await blob.arrayBuffer(); let binary = ''; const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const saved = await Filesystem.writeFile({ path: filename, data: btoa(binary), directory: Directory.Cache, recursive: true });
    try {
      await Share.share({ title: filename, url: saved.uri, dialogTitle: 'Share LBA file' });
      return 'File ready to share.';
    } catch {
      return `File generated: ${filename}`;
    }
  }
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 500); return 'Download started.';
}

async function api(path, options = {}) {
  const isFormData = options.body instanceof FormData;
  const headers = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    ...(options.headers || {})
  };
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) { const error = new Error(data?.error || data || `Request failed: ${res.status}`); error.status = res.status; throw error; }
  return data;
}

function emptyForm() {
  return {
    full_name: '',
    first_name: '',
    last_name: '',
    category_code: 'MS,U15',
    gender: 'Men',
    age_group: 'U15',
    club: '',
    rank_position: '',
    total_points: '',
    tournaments_played: 0,
    status: 'Active',
    notes: ''
  };
}

function App() {
  const [token, setToken] = useState(getToken());
  const [currentUser, setCurrentUser] = useState(() => { try { return JSON.parse(sessionStorage.getItem('lba_user') || 'null'); } catch { return null; } });
  const [activeTab, setActiveTab] = useState('home');
  const [theme, setTheme] = useState(localStorage.getItem('lba_theme') || 'dark');
  const [menuOpen, setMenuOpen] = useState(false);
  const [booting, setBooting] = useState(true);
  const [login, setLogin] = useState({ username: '', password: '' });
  const [authView, setAuthView] = useState('login');
  const [registerForm, setRegisterForm] = useState({ full_name: '', username: '', email: '', password: '', confirm_password: '' });
  const [forgotEmail, setForgotEmail] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [resetForm, setResetForm] = useState({ token: '', password: '', confirm_password: '' });
  const [message, setMessage] = useState('Welcome to the LBA administration system.');
  const [dashboard, setDashboard] = useState(null);
  const [players, setPlayers] = useState([]);
  const [draws, setDraws] = useState([]);
  const [tournaments, setTournaments] = useState([]);
  const [form, setForm] = useState(emptyForm());
  const [filters, setFilters] = useState({ q: '', category: 'All', status: 'All' });
  const [pointInputs, setPointInputs] = useState({});
  const [drawForm, setDrawForm] = useState({ title: 'LBA Tournament Draw', category_code: 'All', draw_type: 'Singles', seed_by_rank: false, player_ids: [] });

  async function loadAll() {
    if (!getToken()) return;
    const params = new URLSearchParams(filters).toString();
    try {
      const [dashboardData, playerData, drawData, tournamentData] = await Promise.all([
        api('/dashboard'),
        api(`/players?${params}`),
        api('/draws'),
        api('/tournaments')
      ]);
      setDashboard(dashboardData);
      setPlayers(playerData);
      setDraws(drawData);
      setTournaments(tournamentData);
    } catch (err) {
      if (err.status === 401) { sessionStorage.removeItem('lba_token'); sessionStorage.removeItem('lba_user'); setToken(''); setCurrentUser(null); setMessage('Your session has expired. Please sign in again.'); } else setMessage(err.message);
    }
  }

  useEffect(() => { loadAll(); }, [token, filters.q, filters.category, filters.status]);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('lba_theme', theme); }, [theme]);
  useEffect(() => { const timer = setTimeout(() => setBooting(false), 1050); return () => clearTimeout(timer); }, []);

  const categoryOptions = useMemo(() => {
    const values = new Set(['All']);
    players.forEach(player => player.category_code && values.add(player.category_code));
    return [...values].sort((a, b) => a === 'All' ? -1 : b === 'All' ? 1 : a.localeCompare(b));
  }, [players]);

  const drawCandidates = useMemo(() => {
    return players.filter(player => {
      const categoryOk = drawForm.category_code === 'All' || player.category_code === drawForm.category_code;
      return player.status === 'Active' && categoryOk;
    });
  }, [players, drawForm.category_code]);

  async function doLogin(e) {
    e.preventDefault();
    try {
      const data = await api('/auth/login', { method: 'POST', body: JSON.stringify(login) });
      sessionStorage.setItem('lba_token', data.token);
      sessionStorage.setItem('lba_user', JSON.stringify(data.user));
      setToken(data.token);
      setCurrentUser(data.user);
      setMessage(`Welcome, ${data.user.full_name}.`);
    } catch (err) {
      setMessage(err.message || 'Failed to login.');
    }
  }

  async function doRegister(e) {
    e.preventDefault();
    if (registerForm.password !== registerForm.confirm_password) {
      setMessage('Passwords do not match.');
      return;
    }
    try {
      await api('/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          full_name: registerForm.full_name,
          username: registerForm.username,
          email: registerForm.email,
          password: registerForm.password
        })
      });
      setVerifyToken('');
      setAuthView('verify');
      setMessage('Account created. Check your email for the verification token.');
    } catch (err) {
      setMessage(err.message || 'Registration failed.');
    }
  }

  async function doVerifyEmail(e) {
    e.preventDefault();
    try {
      await api('/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({ token: verifyToken.trim() })
      });
      setAuthView('login');
      setMessage('Email verified successfully. You can now sign in.');
    } catch (err) {
      setMessage(err.message || 'Email verification failed.');
    }
  }

  async function resendVerification() {
    const identifier = (login.username || '').trim();
    if (!identifier) {
      setAuthView('login');
      setMessage('Enter your username or email on the login screen first.');
      return;
    }
    try {
      const data = await api('/auth/resend-verification', {
        method: 'POST',
        body: JSON.stringify({ email: identifier, username: identifier })
      });
      setAuthView('verify');
      setVerifyToken('');
      setMessage(data?.message || 'A new verification token has been sent to your email.');
    } catch (err) {
      setMessage(err.message || 'Could not resend the verification email.');
    }
  }

  async function doForgotPassword(e) {
    e.preventDefault();
    try {
      const data = await api('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: forgotEmail.trim() })
      });
      setAuthView('reset');
      setResetForm({ token: '', password: '', confirm_password: '' });
      setMessage(data?.message || 'If that email exists, a reset token has been sent.');
    } catch (err) {
      setMessage(err.message || 'Could not start password reset.');
    }
  }

  async function doResetPassword(e) {
    e.preventDefault();
    if (resetForm.password !== resetForm.confirm_password) {
      setMessage('Passwords do not match.');
      return;
    }
    try {
      await api('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token: resetForm.token.trim(), password: resetForm.password })
      });
      setAuthView('login');
      setLogin({ username: '', password: '' });
      setMessage('Password reset successfully. Sign in with your new password.');
    } catch (err) {
      setMessage(err.message || 'Password reset failed.');
    }
  }

  async function savePlayer(e) {
    e.preventDefault();
    try {
      const method = form.id ? 'PUT' : 'POST';
      const path = form.id ? `/players/${form.id}` : '/players';
      await api(path, { method, body: JSON.stringify(form) });
      setForm(emptyForm());
      setMessage(form.id ? 'Player record updated.' : 'Player record added.');
      loadAll();
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function addPoints(player) {
    const raw = pointInputs[player.id];
    const points = Number(raw);
    if (!raw || Number.isNaN(points)) {
      setMessage(`Enter valid points to add for ${player.full_name}.`);
      return;
    }
    try {
      const data = await api(`/players/${player.id}/points`, {
        method: 'POST',
        body: JSON.stringify({ points_delta: points, notes: 'Latest obtained tournament points', increment_tournament: true })
      });
      setPointInputs(current => ({ ...current, [player.id]: '' }));
      setMessage(`${player.full_name}: ${data.old_points} + ${data.added_points} = ${data.new_points}`);
      loadAll();
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function deletePlayer(id) {
    if (!confirm('Delete this player record?')) return;
    try {
      await api(`/players/${id}`, { method: 'DELETE' });
      setMessage('Player deleted.');
      loadAll();
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function generateDraw(e) {
    e.preventDefault();
    if (!drawForm.player_ids.length) {
      setMessage('Select the players who are attending before generating the draw.');
      return;
    }
    try {
      const draw = await api('/draws/random', { method: 'POST', body: JSON.stringify(drawForm) });
      setActiveTab('draws');
      setMessage(`Generated ${draw.matches.length} match(es) using ${draw.selected_player_count} selected player(s).`);
      loadAll();
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function importExcel(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const data = await api('/import/excel', { method: 'POST', body: formData });
      setMessage(`Imported ${data.imported} record(s).`);
      loadAll();
    } catch (err) {
      setMessage(err.message);
    }
  }

  async function exportFile(path, filename) {
    try {
      const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) { const data = await res.json().catch(() => ({})); throw new Error(data?.error || `Export failed (${res.status}).`); }
      setMessage(await saveBlob(await res.blob(), filename));
    } catch (err) { setMessage(err.message); }
  }
  async function exportCsv() { return exportFile('/players/export.csv', 'lba_players.csv'); }

  async function logout() {
    try { if (getToken()) await api('/auth/logout', { method: 'POST' }); } catch {}
    localStorage.removeItem('lba_token');
    localStorage.removeItem('lba_user');
    setToken('');
    setCurrentUser(null);
    setAuthView('login');
    setMessage('You have been signed out.');
  }

  if (!token) {
    return <>
      <AuthScreen
        view={authView}
        setView={setAuthView}
        login={login}
        setLogin={setLogin}
        doLogin={doLogin}
        registerForm={registerForm}
        setRegisterForm={setRegisterForm}
        doRegister={doRegister}
        verifyToken={verifyToken}
        setVerifyToken={setVerifyToken}
        doVerifyEmail={doVerifyEmail}
        resendVerification={resendVerification}
        forgotEmail={forgotEmail}
        setForgotEmail={setForgotEmail}
        doForgotPassword={doForgotPassword}
        resetForm={resetForm}
        setResetForm={setResetForm}
        doResetPassword={doResetPassword}
        message={message}
      />
      {booting && <BootSplash />}
    </>;
  }

  return (
    <>
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <div className="brand"><img src={logo} alt="Lesotho Badminton Association logo" className="brand-logo" /><div><h1>Badminton Admin</h1><p>Lesotho Badminton Association</p></div><button className="close-menu" onClick={() => setMenuOpen(false)}><X size={20}/></button></div>
        {[
          ['home','Overview',Home],['records','Records',Users],['draws','Draws',Shuffle],['tournaments','Tournaments',Trophy],['projector','Projector',MonitorPlay],['reports','Reports',Trophy]
        ].map(([id,label,Icon]) => <button key={id} className={activeTab === id ? 'nav active' : 'nav'} onClick={() => {setActiveTab(id);setMenuOpen(false);}}><Icon size={18}/><span>{label}</span></button>)}
        <button className="nav" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={18}/> : <Moon size={18}/>}<span>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span></button>
        <button className="logout" onClick={logout}><Lock size={17}/> Sign out</button>
      </aside>

      <main className="main">
        <div className="mobile-topbar"><button className="menu-button" onClick={() => setMenuOpen(true)}><Menu size={20}/></button><div><b>LBA ADMIN</b><span>{currentUser?.full_name || "Committee portal"} · {currentUser?.role || "User"}</span></div><div className="secure"><ShieldCheck size={16}/> Secure</div></div>
        {activeTab === "home" && <Overview dashboard={dashboard} players={players} draws={draws} setActiveTab={setActiveTab} exportFile={exportFile}/>} 
        {activeTab !== "home" && <header className="hero">
          <div className="hero-copy"><div className="hero-brand"><img src={logo} alt="Lesotho Badminton Association logo" className="hero-logo" /><div><p className="eyebrow">Administration purposes</p><h2>Ranking Records & Random Draw Management</h2></div></div><p>Update records, add latest obtained points, select tournament participants and generate draws only for players who are attending.</p></div>
          <div className="hero-actions">
            <button className="button secondary" onClick={() => exportFile("/players/export.csv","lba_players.csv")}><Download size={16}/> Export CSV</button>
            <button className="button secondary" onClick={() => exportFile("/players/export.xlsx","lba_players.xlsx")}><FileText size={16}/> Export Excel</button>
            <label className="button"><Upload size={16}/> Import Excel<input type="file" accept=".xlsx,.xls" onChange={importExcel} hidden /></label>
          </div>
        </header>}

        {activeTab !== 'home' && <section className="stats">
          <Stat label="Total Players" value={dashboard?.totalPlayers ?? 0} />
          <Stat label="Active Players" value={dashboard?.activePlayers ?? 0} />
          <Stat label="Categories" value={dashboard?.categories ?? 0} />
          <Stat label="Saved Draws" value={dashboard?.draws ?? 0} />
        </section>}

        <div className="message">{message}</div>
        {activeTab === 'records' && <Records players={players} form={form} setForm={setForm} savePlayer={savePlayer} deletePlayer={deletePlayer} filters={filters} setFilters={setFilters} categoryOptions={categoryOptions} loadAll={loadAll} pointInputs={pointInputs} setPointInputs={setPointInputs} addPoints={addPoints} />}
        {activeTab === 'draws' && <Draws draws={draws} drawForm={drawForm} setDrawForm={setDrawForm} generateDraw={generateDraw} categoryOptions={categoryOptions} drawCandidates={drawCandidates} />}
        {activeTab === 'tournaments' && <TournamentScreen tournaments={tournaments} players={players} categoryOptions={categoryOptions} refresh={loadAll} setMessage={setMessage} />}
        {activeTab === 'projector' && <ProjectorScreen draws={draws} tournaments={tournaments} refresh={loadAll} />}
        {activeTab === 'reports' && <Reports />}
      </main>
      <nav className="mobile-nav">{[["home","Home",Home],["records","Players",Users],["draws","Draws",Shuffle],["tournaments","Tournaments",Trophy],["projector","Projector",MonitorPlay],["reports","Reports",Trophy]].map(([id,label,Icon])=><button key={id} className={activeTab===id?"active":""} onClick={()=>setActiveTab(id)}><Icon size={19}/><span>{label}</span></button>)}</nav>
    </div>
    {booting && <BootSplash />}
    </>
  );
}


function ProjectorScreen({ draws, tournaments, refresh }) {
  const [selectedId, setSelectedId] = useState(draws[0]?.id || null);
  const [full, setFull] = useState(null);
  const [revealing, setRevealing] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!selectedId && draws[0]) setSelectedId(draws[0].id);
  }, [draws, selectedId]);

  useEffect(() => {
    if (!selectedId) { setFull(null); return; }
    api('/draws/'+selectedId).then(setFull).catch(() => setFull(null));
  }, [selectedId]);

  const draw = full || draws.find(d => d.id === selectedId) || draws[0];
  const matches = draw?.matches || [];
  const tournamentName = draw?.event_name || draw?.title || 'LBA Tournament Draw';

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch {}
  }

  function revealDraw() {
    setRevealing(true);
    setRevealed(false);
    window.setTimeout(() => {
      setRevealing(false);
      setRevealed(true);
    }, 1500);
  }

  return <section className="projector-screen">
    <div className="projector-toolbar">
      <div>
        <span className="eyebrow">LIVE TOURNAMENT PRESENTATION</span>
        <h2>Random Draw Presentation</h2>
        <p>Use this screen on the projector to display the generated draw to players and officials.</p>
      </div>
      <div className="quick-actions">
        <select value={selectedId || ''} onChange={e => {setSelectedId(Number(e.target.value));setRevealed(false);}}>
          {!draws.length && <option value="">No draws available</option>}
          {draws.map(d => <option key={d.id} value={d.id}>{d.title} · {d.category_code}</option>)}
        </select>
        <button className="button" onClick={revealDraw} disabled={!matches.length || revealing}>
          <Shuffle size={16}/> {revealing ? 'Revealing…' : 'Reveal Draw'}
        </button>
        <button className="button secondary" onClick={toggleFullscreen}>
          {isFullscreen ? <Minimize size={16}/> : <Maximize size={16}/>} {isFullscreen ? 'Exit Fullscreen' : 'Projector Fullscreen'}
        </button>
      </div>
    </div>

    {!draw ? <div className="projector-empty"><MonitorPlay size={60}/><h2>No draw available</h2><p>Generate a draw first, then return here to present it.</p></div> :
      <div className="projector-board">
        <div className="projector-title">
          <img src={logo} alt="LBA" />
          <div>
            <span>LESOTHO BADMINTON ASSOCIATION</span>
            <h1>{tournamentName}</h1>
            <p>{draw.category_code} · {draw.draw_type} · {matches.length} matches · {revealed ? 'DRAW REVEALED' : 'READY TO REVEAL'}</p>
          </div>
        </div>
        {revealing && <div className="draw-reveal-animation">
          <Shuffle size={54}/><b>SHUFFLING PLAYERS…</b><span>Random draw generated by the tournament system</span>
        </div>}
        {!revealing && <div className="projector-matches">
          {matches.map((m,i) => <div className="projector-match" key={m.id}>
            <span className="projector-match-no">MATCH {m.match_no}</span>
            <div><strong>{revealed ? m.side_a : 'PLAYER A'}</strong><em>VS</em><strong>{revealed ? m.side_b : 'PLAYER B'}</strong></div>
          </div>)}
        </div>}
        <div className="projector-footer">
          <span>Generated by LBA Tournament System</span>
          <span>{draw.created_at || ''}</span>
        </div>
      </div>}
  </section>;
}


function Overview({ dashboard, players, draws, setActiveTab, exportFile }) {
  const top = dashboard?.topPlayers || [];
  const categories = dashboard?.categoryBreakdown || [];
  return <section className="overview-page">
    <section className="welcome-card"><div><span className="eyebrow">LESOTHO BADMINTON ASSOCIATION</span><h2>Committee dashboard</h2><p>Manage rankings, player records and tournament draws from one professional workspace.</p><div className="quick-actions"><button className="button" onClick={() => setActiveTab('records')}><Plus size={16}/> Add player</button><button className="button secondary" onClick={() => setActiveTab('draws')}><Shuffle size={16}/> Create draw</button><button className="button secondary" onClick={() => exportFile('/players/export.xlsx','lba_players.xlsx')}><FileText size={16}/> Export Excel</button></div></div><div className="court-badge"><span>🏸</span><b>PLAY</b><b>RANK</b><b>GROW</b></div></section>
    <section className="stats"><Stat label="Registered players" value={dashboard?.totalPlayers ?? 0}/><Stat label="Active players" value={dashboard?.activePlayers ?? 0}/><Stat label="Categories" value={dashboard?.categories ?? 0}/><Stat label="Saved draws" value={dashboard?.draws ?? 0}/></section>
    <section className="dashboard-grid"><div className="panel"><div className="section-head"><div><span className="eyebrow">RANKING SNAPSHOT</span><h3>Leading players</h3></div><button className="text-btn" onClick={() => setActiveTab('records')}>View register</button></div><div className="ranking-list">{top.map((p,i)=><div className="rank-row" key={p.id}><strong className={`rank-no rank-${i+1}`}>{i+1}</strong><div className="avatar">{p.full_name.split(' ').map(x=>x[0]).slice(0,2).join('')}</div><div className="rank-name"><b>{p.full_name}</b><small>{p.category_code} · {p.club || 'Independent'}</small></div><strong>{p.total_points}<small>points</small></strong></div>)}{!top.length&&<div className="empty">No ranking records yet.</div>}</div></div>
      <div className="panel"><div className="section-head"><div><span className="eyebrow">PARTICIPATION</span><h3>Categories</h3></div></div><div className="category-list">{categories.map(c=><div className="category-row" key={c.category_code}><div><b>{c.category_code}</b><small>{c.event_type} · {c.age_group}</small></div><strong>{c.player_count}</strong></div>)}</div>{!categories.length&&<div className="empty">Import player records to see category activity.</div>}</div></section>
    <section className="panel feature-strip"><div><Trophy size={20}/><div><b>Tournament centre</b><span>{draws.length ? `${draws.length} saved draw(s) available.` : 'No draws yet. Create one when players confirm attendance.'}</span></div></div><button className="button" onClick={() => setActiveTab('draws')}>Open draw manager</button></section>
  </section>;
}

function BootSplash() {
  return <div className="boot-splash" aria-label="Loading LBA Admin">
    <div className="boot-logo-wrap"><img src={logo} alt="" className="boot-logo"/><span className="boot-shuttle">🏸</span></div>
    <div className="boot-title">LBA ADMIN</div>
    <div className="boot-subtitle">Lesotho Badminton Association</div>
    <div className="boot-line"><span/></div>
  </div>;
}

function AuthScreen({
  view, setView, login, setLogin, doLogin,
  registerForm, setRegisterForm, doRegister,
  verifyToken, setVerifyToken, doVerifyEmail, resendVerification,
  forgotEmail, setForgotEmail, doForgotPassword,
  resetForm, setResetForm, doResetPassword, message
}) {
  const title = {
    login: 'LBA Admin Login',
    register: 'Create LBA Account',
    verify: 'Verify Your Email',
    forgot: 'Forgot Password',
    reset: 'Reset Password'
  }[view];

  const subtitle = {
    login: 'Sign in to the Lesotho Badminton Association administration portal.',
    register: 'Create your individual committee account.',
    verify: 'Enter the verification token sent to your email.',
    forgot: 'Enter your email and we will send a password reset token.',
    reset: 'Enter the token from your email and choose a new password.'
  }[view];

  return <div className="login-page">
    <form className="login-card auth-card" onSubmit={
      view === 'login' ? doLogin :
      view === 'register' ? doRegister :
      view === 'verify' ? doVerifyEmail :
      view === 'forgot' ? doForgotPassword : doResetPassword
    }>
      <img src={logo} alt="Lesotho Badminton Association logo" className="login-logo" />
      <div className="lock"><Lock /></div>
      <h1>{title}</h1>
      <p>{subtitle}</p>

      {view === 'login' && <>
        <input placeholder="Username or email" autoComplete="username" value={login.username} onChange={e => setLogin({ ...login, username: e.target.value })}/>
        <input placeholder="Password" type="password" autoComplete="current-password" value={login.password} onChange={e => setLogin({ ...login, password: e.target.value })}/>
        <button className="button full">Login</button>
        <div className="auth-links">
          <button type="button" onClick={() => setView('forgot')}>Forgot password?</button>
          <button type="button" onClick={() => setView('register')}>Create account</button>
        </div>
      </>}

      {view === 'register' && <>
        <input placeholder="Full name" autoComplete="name" value={registerForm.full_name} onChange={e => setRegisterForm({ ...registerForm, full_name: e.target.value })}/>
        <input placeholder="Username" autoComplete="username" value={registerForm.username} onChange={e => setRegisterForm({ ...registerForm, username: e.target.value })}/>
        <input placeholder="Email address" type="email" autoComplete="email" value={registerForm.email} onChange={e => setRegisterForm({ ...registerForm, email: e.target.value })}/>
        <input placeholder="Password (8+ characters)" type="password" autoComplete="new-password" value={registerForm.password} onChange={e => setRegisterForm({ ...registerForm, password: e.target.value })}/>
        <input placeholder="Confirm password" type="password" autoComplete="new-password" value={registerForm.confirm_password} onChange={e => setRegisterForm({ ...registerForm, confirm_password: e.target.value })}/>
        <button className="button full">Create account</button>
        <div className="auth-links"><button type="button" onClick={() => setView('login')}>Back to login</button></div>
      </>}

      {view === 'verify' && <>
        <input placeholder="Verification token" value={verifyToken} onChange={e => setVerifyToken(e.target.value)} autoComplete="one-time-code"/>
        <button className="button full">Verify email</button>
        <div className="auth-links"><button type="button" onClick={() => setView('login')}>Back to login</button><button type="button" onClick={resendVerification}>Resend token</button></div>
      </>}

      {view === 'forgot' && <>
        <input placeholder="Email address" type="email" autoComplete="email" value={forgotEmail} onChange={e => setForgotEmail(e.target.value)}/>
        <button className="button full">Send reset email</button>
        <div className="auth-links"><button type="button" onClick={() => setView('login')}>Back to login</button></div>
      </>}

      {view === 'reset' && <>
        <input placeholder="Reset token" value={resetForm.token} onChange={e => setResetForm({ ...resetForm, token: e.target.value })} autoComplete="one-time-code"/>
        <input placeholder="New password (8+ characters)" type="password" autoComplete="new-password" value={resetForm.password} onChange={e => setResetForm({ ...resetForm, password: e.target.value })}/>
        <input placeholder="Confirm new password" type="password" autoComplete="new-password" value={resetForm.confirm_password} onChange={e => setResetForm({ ...resetForm, confirm_password: e.target.value })}/>
        <button className="button full">Reset password</button>
        <div className="auth-links"><button type="button" onClick={() => setView('login')}>Back to login</button></div>
      </>}

      <small className="auth-message">{message}</small>
      {view === 'login' && <small className="auth-note">Accounts must be verified by email before first sign-in.</small>}
    </form>
  </div>;
}


function Records({ players, form, setForm, savePlayer, deletePlayer, filters, setFilters, categoryOptions, loadAll, pointInputs, setPointInputs, addPoints }) {
  return <section className="grid two"><div className="panel"><h3>{form.id ? 'Update Player' : 'Add Player'}</h3><form onSubmit={savePlayer} className="form"><Input label="Full name" value={form.full_name} onChange={v => setForm({ ...form, full_name: v })}/><div className="form-row"><Input label="First name" value={form.first_name} onChange={v => setForm({ ...form, first_name: v })}/><Input label="Last name" value={form.last_name} onChange={v => setForm({ ...form, last_name: v })}/></div><div className="form-row"><Input label="Category" value={form.category_code} onChange={v => setForm({ ...form, category_code: v })}/><Input label="Age group" value={form.age_group} onChange={v => setForm({ ...form, age_group: v })}/></div><div className="form-row"><Input label="Gender" value={form.gender} onChange={v => setForm({ ...form, gender: v })}/><Input label="Club" value={form.club} onChange={v => setForm({ ...form, club: v })}/></div><div className="form-row"><Input label="Rank" type="number" value={form.rank_position} onChange={v => setForm({ ...form, rank_position: v })}/><Input label="Total points correction" type="number" value={form.total_points} onChange={v => setForm({ ...form, total_points: v })}/></div><p className="helper">Use the table's “Add points” box to add latest tournament points. Example: 120 + 20 = 140.</p><label><span>Status</span><select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}><option>Active</option><option>Inactive</option></select></label><label><span>Notes</span><textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}/></label><div className="actions"><button className="button"><Plus size={16}/> Save</button><button type="button" className="button secondary" onClick={() => setForm(emptyForm())}>Clear</button></div></form></div><div className="panel wide"><div className="toolbar"><div className="search"><Search size={16}/><input placeholder="Search player, club or category" value={filters.q} onChange={e => setFilters({ ...filters, q: e.target.value })} onKeyDown={e => e.key === 'Enter' && loadAll()} /></div><select value={filters.category} onChange={e => setFilters({ ...filters, category: e.target.value })}>{categoryOptions.map(c => <option key={c}>{c}</option>)}</select><select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}><option>All</option><option>Active</option><option>Inactive</option></select><button className="icon-btn" onClick={loadAll}><RefreshCw size={16}/></button></div><div className="table-wrap"><table><thead><tr><th>Rank</th><th>Name</th><th>Category</th><th>Club</th><th>Points</th><th>Add latest points</th><th>Status</th><th></th></tr></thead><tbody>{players.map(p => <tr key={p.id}><td>#{p.rank_position || '-'}</td><td><b>{p.full_name}</b><small>{p.gender} · {p.age_group}</small></td><td>{p.category_code}</td><td>{p.club || '-'}</td><td><b>{p.total_points}</b></td><td><div className="points-add"><input type="number" placeholder="+ points" value={pointInputs[p.id] || ''} onChange={e => setPointInputs(current => ({ ...current, [p.id]: e.target.value }))}/><button className="mini green" onClick={() => addPoints(p)}>Add</button></div></td><td><span className={p.status === 'Active' ? 'badge green' : 'badge'}>{p.status}</span></td><td><button className="mini" onClick={() => setForm(p)}>Edit</button><button className="mini danger" onClick={() => deletePlayer(p.id)}><Trash2 size={14}/></button></td></tr>)}</tbody></table></div></div></section>;
}

function Draws({ draws, drawForm, setDrawForm, generateDraw, categoryOptions, drawCandidates }) {
  const [selected, setSelected] = useState(null);
  const selectedSet = new Set(drawForm.player_ids || []);
  const allVisibleIds = drawCandidates.map(player => player.id);
  function togglePlayer(id) {
    setDrawForm(current => {
      const ids = new Set(current.player_ids || []);
      ids.has(id) ? ids.delete(id) : ids.add(id);
      return { ...current, player_ids: [...ids] };
    });
  }
  function selectAllVisible() {
    setDrawForm(current => ({ ...current, player_ids: allVisibleIds }));
  }
  function clearSelection() {
    setDrawForm(current => ({ ...current, player_ids: [] }));
  }
  function changeCategory(value) {
    setDrawForm(current => ({ ...current, category_code: value, player_ids: [] }));
  }
  return <section className="grid two"><div className="panel"><h3>Generate Random Draw</h3><form onSubmit={generateDraw} className="form"><Input label="Draw title" value={drawForm.title} onChange={v => setDrawForm({ ...drawForm, title: v })}/><label><span>Category</span><select value={drawForm.category_code} onChange={e => changeCategory(e.target.value)}>{categoryOptions.map(c => <option key={c}>{c}</option>)}</select></label><label><span>Draw type</span><select value={drawForm.draw_type} onChange={e => setDrawForm({ ...drawForm, draw_type: e.target.value })}><option>Singles</option><option>Doubles</option></select></label><label className="check"><input type="checkbox" checked={drawForm.seed_by_rank} onChange={e => setDrawForm({ ...drawForm, seed_by_rank: e.target.checked })}/> Seed by ranking instead of full random shuffle</label><div className="participant-head"><b>Attending players</b><span>{selectedSet.size} selected</span></div><div className="participant-actions"><button type="button" className="mini" onClick={selectAllVisible}>Select all shown</button><button type="button" className="mini" onClick={clearSelection}>Clear</button></div><div className="participant-list">{drawCandidates.length ? drawCandidates.map(player => <label className="participant" key={player.id}><input type="checkbox" checked={selectedSet.has(player.id)} onChange={() => togglePlayer(player.id)} /><span><b>{player.full_name}</b><small>{player.category_code} · Rank #{player.rank_position || '-'} · {player.total_points} pts</small></span></label>) : <div className="empty small">No active players found in this category.</div>}</div><button className="button"><Shuffle size={16}/> Generate Draw From Selected</button></form><h3>Saved Draws</h3><div className="draw-list">{draws.map(d => <button key={d.id} onClick={() => setSelected(d)} className="draw-item"><b>{d.title}</b><small>{d.category_code} · {d.draw_type} · {d.created_at}</small></button>)}</div></div><div className="panel wide"><h3>{selected?.title || 'Latest Draw'}</h3>{(selected || draws[0]) ? <DrawMatches draw={selected || draws[0]} /> : <div className="empty">No draw yet. Select attending players and generate one from the left panel.</div>}</div></section>;
}

function DrawMatches({ draw }) {
  const [full, setFull] = useState(null);
  const [pdfMessage, setPdfMessage] = useState('');

  useEffect(() => {
    setFull(null);
    setPdfMessage('');
    api(`/draws/${draw.id}`).then(setFull).catch(() => setFull(null));
  }, [draw.id]);

  const currentDraw = full || draw;
  const matches = currentDraw?.matches || [];

  async function exportDrawPdf() {
    try {
      const res = await fetch(`${API_BASE}/draws/${currentDraw.id}/export.pdf`, {
        headers: { Authorization: `Bearer ${getToken()}` }
      });
      if (!res.ok) {
        let err = 'PDF export failed.';
        try {
          const data = await res.json();
          err = data?.error || err;
        } catch {}
        throw new Error(err);
      }
      const blob = await res.blob();
      const safeTitle = (currentDraw.title || "lba_draw").replace(/[^a-z0-9_-]+/gi, "_");
      setPdfMessage(await saveBlob(blob, `${safeTitle}_${currentDraw.id}.pdf`));
    } catch (err) {
      setPdfMessage(err.message);
    }
  }

  return <div className="fixtures">
    <div className="draw-header">
      <div>
        <b>{currentDraw.title}</b>
        <small>{currentDraw.category_code} · {currentDraw.draw_type} · {matches.length} match(es)</small>
      </div>
      <button className="button secondary" onClick={exportDrawPdf}><FileText size={16}/> Export Draw PDF</button>
    </div>
    {pdfMessage && <div className="helper">{pdfMessage}</div>}
    {matches.map(m => <div className="fixture" key={m.id}><small>Match {m.match_no}</small><div><b>{m.side_a}</b><span>VS</span><b>{m.side_b}</b></div></div>)}
  </div>;
}


function formatLbaTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-ZA', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Africa/Maseru'
  }).format(date) + ' SAST';
}

function TournamentScreen({ tournaments, players, categoryOptions, refresh, setMessage }) {
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState({name:'',tournament_code:'',venue:'',start_date:'',end_date:'',status:'Draft'});
  const [draw, setDraw] = useState({title:'Tournament Draw',category_code:'All',draw_type:'Singles',event_name:'MS',seed_by_rank:false,player_ids:[]});
  const [openResult, setOpenResult] = useState(null);
  const [resultDirty, setResultDirty] = useState(false);
  const [games, setGames] = useState([{a:'',b:''},{a:'',b:''},{a:'',b:''}]);
  const [busy, setBusy] = useState(false);
  const [historyDetails, setHistoryDetails] = useState({});

  async function load(id=selectedId) {
    if (!id) { setDetail(null); return null; }
    try {
      const data=await api('/tournaments/'+id);
      setDetail(data);
      return data;
    } catch (e) {
      setMessage(e.message);
      return null;
    }
  }

  useEffect(() => { if (selectedId) load(selectedId); }, [selectedId]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const completed = tournaments.filter(t => t.status === 'Completed');
      const entries = await Promise.all(completed.map(async t => {
        try {
          const d = await api('/tournaments/'+t.id);
          return [t.id, d];
        } catch (_) {
          return [t.id, null];
        }
      }));
      if (!cancelled) {
        setHistoryDetails(prev => {
          const next = {...prev};
          entries.forEach(([id,d]) => { if (d) next[id]=d; });
          return next;
        });
      }
    })();
    return () => { cancelled = true; };
  }, [tournaments]);

  const candidates = useMemo(() => {
    return players.filter(p => {
      if (p.status !== 'Active') return false;
      const categoryOk = draw.category_code === 'All' || p.category_code === draw.category_code;
      if (!categoryOk) return false;
      const event = draw.event_name;
      if (event === 'MS' || event === 'MD') return p.gender === 'Men';
      if (event === 'WS' || event === 'WD') return p.gender === 'Women';
      if (event === 'XD') return p.gender === 'Men' || p.gender === 'Women';
      return true;
    });
  }, [players, draw.category_code, draw.event_name]);

  const rounds = useMemo(() => {
    const map = new Map();
    (detail?.matches || []).forEach(m => {
      const rn = Number(m.round_number || 1);
      if (!map.has(rn)) map.set(rn, { number: rn, stage: m.stage || m.draw_round || ('Round '+rn), matches: [] });
      map.get(rn).matches.push(m);
    });
    return [...map.values()].sort((a,b) => a.number-b.number);
  }, [detail]);

  const latestRound = rounds[rounds.length-1];
  const latestRoundComplete = !!latestRound && latestRound.matches.length > 0 && latestRound.matches.every(m => m.status === 'Completed');
  const hasLaterRound = rounds.length > 1;
  const finalMatch = (detail?.matches || []).find(m => m.stage === 'Final' && m.match_no !== 3);
  const thirdMatch = (detail?.matches || []).find(m => m.stage === 'Final' && m.match_no === 3);
  const readyToFinish = finalMatch?.status === 'Completed' && (!thirdMatch || thirdMatch.status === 'Completed');
  const podium = detail?.podium || {};

  function togglePlayer(id) {
    setDraw(x => {
      const ids = new Set(x.player_ids);
      if (ids.has(id)) ids.delete(id); else ids.add(id);
      return {...x, player_ids:[...ids]};
    });
  }

  async function createTournament(e) {
    e.preventDefault();
    if (!form.name.trim()) { setMessage('Tournament name is required.'); return; }
    setBusy(true);
    try {
      const t = await api('/tournaments', {method:'POST', body:JSON.stringify(form)});
      setForm({name:'',tournament_code:'',venue:'',start_date:'',end_date:'',status:'Draft'});
      await refresh();
      setSelectedId(t.id);
      setMessage('Tournament created. Select the attending players to generate Round 1.');
    } catch (e) { setMessage(e.message); }
    finally { setBusy(false); }
  }

  async function generateTournamentDraw(e) {
    e.preventDefault();
    if (!selectedId || draw.player_ids.length < 2) { setMessage('Select at least two attending players first.'); return; }
    setBusy(true);
    try {
      await api('/tournaments/'+selectedId+'/draw', {
        method:'POST',
        body:JSON.stringify({
          title: draw.title,
          category_code: draw.category_code,
          draw_type: draw.draw_type,
          event_name: draw.event_name,
          seed_by_rank: draw.seed_by_rank,
          player_ids: draw.player_ids
        })
      });
      await load(selectedId);
      await refresh();
      setMessage('Round 1 draw generated. Winners will advance automatically after results are entered.');
    } catch (e) { setMessage(e.message); }
    finally { setBusy(false); }
  }

  async function generateNextRound(silent=false) {
    if (!selectedId) return null;
    setBusy(true);
    try {
      const next = await api('/tournaments/'+selectedId+'/next-round', {
        method:'POST',
        body:JSON.stringify({event_name:draw.event_name,draw_type:draw.draw_type})
      });
      await load(selectedId);
      await refresh();
      if (!silent) setMessage(next?.stage ? next.stage+' generated from the previous round winners.' : 'Next round generated.');
      return next;
    } catch (e) {
      if (!silent) setMessage(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  function startResult(m) {
    setResultDirty(false);
    setOpenResult(m.id);
    const old = m.games || [];
    setGames([0,1,2].map(i => ({a: old[i] ? old[i].side_a_score : '', b: old[i] ? old[i].side_b_score : ''})));
  }

  useEffect(() => {
    if (!openResult) {
      setResultDirty(false);
      return;
    }
    const hasTypedScore = games.some(g => String(g.a ?? '').trim() !== '' || String(g.b ?? '').trim() !== '');
    setResultDirty(hasTypedScore);
  }, [games, openResult]);

  async function saveResult(matchId) {
    const used = games
      .filter(g => g.a !== '' && g.b !== '')
      .map(g => ({side_a_score:Number(g.a),side_b_score:Number(g.b)}));

    if (used.length < 2) {
      setMessage('A badminton match needs at least two completed games. Enter Game 1 and Game 2, then Game 3 only if needed.');
      return;
    }

    const game1Winner = used[0].side_a_score > used[0].side_b_score ? 'A' : 'B';
    const game2Winner = used[1].side_a_score > used[1].side_b_score ? 'A' : 'B';
    if (game1Winner === game2Winner && used.length > 2) {
      setMessage('The match is already decided after two games. Remove Game 3 or leave it blank.');
      return;
    }
    if (game1Winner !== game2Winner && used.length < 3) {
      setMessage('The first two games are split. Enter Game 3 to decide the match.');
      return;
    }

    setBusy(true);
    try {
      const saved = await api('/matches/'+matchId+'/result', {
        method:'POST',
        body:JSON.stringify({games:used})
      });

      // Do not close the result editor until the server has confirmed the
      // match as Completed.
      if (!saved || saved.status !== 'Completed' || !saved.winner) {
        throw new Error('The server did not confirm the match result as completed.');
      }

      setOpenResult(null);
      setResultDirty(false);
      const updated = await load(selectedId);
      await refresh();

      const updatedRounds = {};
      (updated?.matches || []).forEach(m => {
        const rn=Number(m.round_number || 1);
        if (!updatedRounds[rn]) updatedRounds[rn]=[];
        updatedRounds[rn].push(m);
      });

      const roundNumbers=Object.keys(updatedRounds).map(Number).sort((a,b)=>a-b);
      const latestRn=roundNumbers[roundNumbers.length-1];
      const latestMatches=updatedRounds[latestRn] || [];
      const latestDrawStage=latestMatches[0]?.stage || '';
      const nextAlreadyExists=(updated?.matches || []).some(m => Number(m.round_number || 1) > latestRn);

      if (latestMatches.length && latestMatches.every(m => m.status === 'Completed') && latestDrawStage !== 'Final' && !nextAlreadyExists) {
        await generateNextRound(true);
        setMessage('Match result saved. All winners have advanced to the next round.');
      } else {
        setMessage(saved.winner+' won the match. Result saved successfully.');
      }
    } catch (e) {
      setMessage('Result was not saved: '+e.message);
    } finally {
      setBusy(false);
    }
  }

  async function finishTournament() {
    if (!selectedId) return;
    if (!readyToFinish) {
      setMessage(thirdMatch?.status !== 'Completed' ? 'Complete the final and third-place match before declaring the tournament finished.' : 'Complete the final before declaring the tournament finished.');
      return;
    }
    if (!confirm('Declare this tournament officially finished? This will record the final podium and completion time.')) return;
    setBusy(true);
    try {
      const result=await api('/tournaments/'+selectedId+'/finish',{method:'POST'});
      await load(selectedId);
      await refresh();
      setMessage('Tournament finished. Champion: '+(result.winner_name || 'recorded')+'.');
    } catch (e) { setMessage(e.message); }
    finally { setBusy(false); }
  }

  async function exportFile(path, name) {
    try {
      const res = await fetch(API_BASE+path,{headers:{Authorization:'Bearer '+getToken()}});
      if (!res.ok) {
        const data=await res.json().catch(()=>({}));
        throw new Error(data?.error || 'Export failed.');
      }
      setMessage(await saveBlob(await res.blob(),name));
    } catch (e) { setMessage(e.message); }
  }

  return <section className="grid two">
    <div className="panel">
      <div className="section-head">
        <div><span className="eyebrow">TOURNAMENT MANAGEMENT</span><h3>Tournaments</h3></div>
        <CalendarDays size={22}/>
      </div>

      <form className="form" onSubmit={createTournament}>
        <Input label="Tournament name" value={form.name} onChange={v=>setForm({...form,name:v})}/>
        <Input label="Tournament code (optional)" value={form.tournament_code} onChange={v=>setForm({...form,tournament_code:v})}/>
        <Input label="Venue" value={form.venue} onChange={v=>setForm({...form,venue:v})}/>
        <div className="grid two">
          <Input label="Start date" type="date" value={form.start_date} onChange={v=>setForm({...form,start_date:v})}/>
          <Input label="End date" type="date" value={form.end_date} onChange={v=>setForm({...form,end_date:v})}/>
        </div>
        <button className="button" disabled={busy}><Plus size={16}/> Create Tournament</button>
      </form>

      <div className="draw-list">
        {tournaments.map(t=>
          <button key={t.id} className={selectedId===t.id ? 'draw-item selected' : 'draw-item'} onClick={()=>setSelectedId(t.id)}>
            <b>{t.name}</b>
            <small>{t.tournament_code} · {t.status} · {t.completed_matches || 0}/{t.total_matches || 0} matches complete</small>
            {t.start_date && <small>{t.start_date}{t.end_date && t.end_date!==t.start_date ? ' → '+t.end_date : ''}</small>}
          </button>
        )}
        {!tournaments.length&&<div className="empty">No tournaments yet.</div>}
      </div>

      <div className="tournament-history-summary">
        <div className="history-heading">
          <span className="eyebrow">ARCHIVE</span>
          <h3>Tournament History</h3>
        </div>
        {tournaments.filter(t => t.status === 'Completed').map(t => {
          const h=historyDetails[t.id];
          const p=h?.podium || {};
          const thirdPlayers=p.third_players || (p.third ? [p.third] : []);
          return <button className="history-card" key={'history-card-'+t.id} onClick={()=>setSelectedId(t.id)}>
            <div className="history-card-title"><b>{t.name}</b><span>{t.venue || 'Venue not recorded'}</span></div>
            <div className="history-card-grid">
              <div><small>1st Place</small><strong>{p.first || '—'}</strong></div>
              <div><small>2nd Place</small><strong>{p.second || '—'}</strong></div>
              <div><small>3rd Place</small><strong>{thirdPlayers.length ? thirdPlayers.join(' & ') : '—'}</strong></div>
              <div><small>Date</small><strong>{t.start_date || (h?.finished_at ? formatLbaTime(h.finished_at).split(',')[0] : '—')}</strong></div>
            </div>
          </button>;
        })}
        {!tournaments.some(t => t.status === 'Completed') && <div className="empty small">Completed tournaments will appear here.</div>}
      </div>
    </div>

    <div className="panel wide">
      {!detail ? <div className="empty"><Trophy size={32}/><h3>Select a tournament</h3><p>Create a tournament on the left, then generate Round 1 and enter results here.</p></div> :
      <>
        <div className="section-head">
          <div>
            <span className="eyebrow">{detail.tournament_code}</span>
            <h3>{detail.name}</h3>
            <p>{detail.venue || 'Venue not set'} · {detail.start_date || 'Date not set'} · <b>{detail.status}</b></p>
            <small className="server-clock">System time: {formatLbaTime(detail.server_time)} · Lesotho / SAST (UTC+02:00)</small>
          </div>
          <div className="quick-actions">
            <button className="button secondary" onClick={()=>exportFile('/tournaments/'+detail.id+'/scoresheets.pdf',detail.tournament_code+'_scoresheets.pdf')}><ClipboardList size={16}/> Scoresheets</button>
            <button className="button secondary" onClick={()=>exportFile('/tournaments/'+detail.id+'/export.xlsx',detail.tournament_code+'_tournament.xlsx')}><Download size={16}/> Full Tournament Excel</button>
          </div>
        </div>

        {(podium.first || podium.second || podium.third) && <div className="podium-card">
          <div className="podium-title"><Trophy size={20}/> Tournament Podium</div>
          <div className="podium-grid">
            <div><span>1st</span><b>{podium.first || '—'}</b></div>
            <div><span>2nd</span><b>{podium.second || '—'}</b></div>
            <div><span>3rd</span><b>{podium.third || '—'}</b></div>
          </div>
          {detail.finished_at && <small>Declared finished by {detail.finished_by || 'admin'} on {formatLbaTime(detail.finished_at)}</small>}
        </div>}

        <div className="stats">
          <Stat label="Rounds" value={rounds.length}/>
          <Stat label="Matches" value={(detail.matches || []).length}/>
          <Stat label="Completed" value={(detail.matches || []).filter(m=>m.status==='Completed').length}/>
          <Stat label="Pending" value={(detail.matches || []).filter(m=>m.status!=='Completed').length}/>
        </div>

        {!rounds.length ? <div className="panel">
          <h3>Set up Round 1</h3>
          <form className="form" onSubmit={generateTournamentDraw}>
            <div className="tournament-setup-grid">
              <Input label="Draw title" value={draw.title} onChange={v=>setDraw({...draw,title:v})}/>
              <label><span>Event</span><select value={draw.event_name} onChange={e=>setDraw({...draw,event_name:e.target.value,player_ids:[]})}>
                <option value="MS">MS — Boys Singles</option>
                <option value="WS">WS — Girls Singles</option>
                <option value="MD">MD — Boys Doubles</option>
                <option value="WD">WD — Girls Doubles</option>
                <option value="XD">XD — Mixed Doubles</option>
              </select></label>
              <label><span>Category / Age</span><select value={draw.category_code} onChange={e=>setDraw({...draw,category_code:e.target.value,player_ids:[]})}>{categoryOptions.map(c=><option key={c}>{c}</option>)}</select></label>
              <label className="check setup-seed"><input type="checkbox" checked={draw.seed_by_rank} onChange={e=>setDraw({...draw,seed_by_rank:e.target.checked})}/> Seed the first round by ranking</label>
            </div>
            <div className="participant-head"><b>Attending players</b><span>{draw.player_ids.length} selected</span></div>
            <div className="participant-actions"><button type="button" className="mini" onClick={()=>setDraw(x=>({...x,player_ids:candidates.map(p=>p.id)}))}>Select all shown</button><button type="button" className="mini" onClick={()=>setDraw(x=>({...x,player_ids:[]}))}>Clear</button></div>
            <div className="participant-list">{candidates.map(p=><label className="participant" key={p.id}><input type="checkbox" checked={draw.player_ids.includes(p.id)} onChange={()=>togglePlayer(p.id)}/><span><b>{p.full_name}</b><small>{p.category_code} · {p.gender} · {p.event_type || '—'} · Rank #{p.rank_position || '-'} · {p.total_points} pts</small></span></label>)}{!candidates.length&&<div className="empty small">No active players found in this category.</div>}</div>
            <button className="button" disabled={busy}><Shuffle size={16}/> Generate Round 1 Draw</button>
          </form>
        </div> : <div className="panel round-workspace">
          <div className="round-action-bar">
            <div><b>Knockout progression</b><small>Complete a round and the winners are automatically carried into the next round.</small></div>
            <div className="quick-actions">
              {latestRoundComplete && !hasLaterRound && latestRound?.stage !== 'Final' && <button className="button secondary" disabled={busy} onClick={()=>generateNextRound(false)}><Shuffle size={16}/> Generate Next Round</button>}
              {readyToFinish && detail.status !== 'Completed' && <button className="button" disabled={busy} onClick={finishTournament}><Trophy size={16}/> Declare Tournament Finished</button>}
            </div>
          </div>

          {rounds.map(round => <section className="round-section" key={round.number}>
            <div className="round-heading"><div><span className="eyebrow">ROUND {round.number}</span><h3>{round.stage}</h3></div><span className={round.matches.every(m=>m.status==='Completed') ? 'badge green' : 'badge'}>{round.matches.filter(m=>m.status==='Completed').length}/{round.matches.length} complete</span></div>
            <div className="fixtures">
              {round.matches.map(m => {
                const isThird=m.stage==='Final' && m.match_no===3;
                const label=isThird ? 'Third Place' : (m.stage || round.stage);
                const courtText=m.court ? ' · Court '+m.court : '';
                const scoreText=m.games?.length ? ' · '+m.games.map(g=>g.side_a_score+'-'+g.side_b_score).join(', ') : ' · BYE';
                const recordedText=m.result_updated_at ? ' · '+formatLbaTime(m.result_updated_at) : '';
                return <div className="fixture tournament-fixture" key={m.id}>
                  <small>{m.match_code || ('Match '+m.match_no)} · {label}{courtText}</small>
                  <div><b>{m.side_a}</b><span>VS</span><b>{m.side_b}</b></div>
                  {m.status === 'Completed' ? <div className="helper"><CheckCircle2 size={15}/> {m.winner}{scoreText}{recordedText}</div> :
                    <button className="mini" onClick={()=>startResult(m)}>Record Result</button>}
                  {openResult === m.id && <div className="form result-entry">
                    <b>Enter game scores — best of 3</b>
                    {games.map((g,i)=><div className="grid two" key={i}><Input label={'Game '+(i+1)+' · Player A'} type="number" value={g.a} onChange={v=>{setResultDirty(true);setGames(gs=>gs.map((x,j)=>j===i?{...x,a:v}:x))}}/><Input label={'Game '+(i+1)+' · Player B'} type="number" value={g.b} onChange={v=>{setResultDirty(true);setGames(gs=>gs.map((x,j)=>j===i?{...x,b:v}:x))}}/></div>)}
                    <small className="helper">Badminton scoring: 21-point games, win by 2 after 20-all, with 30 as the maximum.</small>
                    <button type="button" className={resultDirty ? "button result-save-button" : "button"} onClick={()=>saveResult(m.id)} disabled={busy || !resultDirty}>
                      {busy ? 'Saving…' : resultDirty ? 'Save' : 'Record Results'}
                    </button>
                  </div>}
                </div>;
              })}
            </div>
          </section>)}

          {finalMatch?.status === 'Completed' && thirdMatch?.status !== 'Completed' && <div className="message">Final recorded. Complete the third-place match before declaring the tournament finished.</div>}
          {detail.status === 'Completed' && <div className="message">This tournament is officially closed. The podium and complete history are preserved below.</div>}

          <section className="tournament-round-history">
            <div className="history-heading">
              <div>
                <span className="eyebrow">COMPLETE TOURNAMENT RECORD</span>
                <h3>Round-by-Round Matches</h3>
                <p>Every round is kept separately. Winners shown in one round are the players used to create the following round.</p>
              </div>
            </div>

            {rounds.map(round => {
              const completed=round.matches.filter(m=>m.status==='Completed');
              const winners=completed.filter(m=>m.winner && m.winner!=='Bye').map(m=>m.winner);
              return <section className="history-round" key={'history-'+round.number}>
                <div className="history-round-head">
                  <div>
                    <span className="eyebrow">ROUND {round.number}</span>
                    <h4>{round.stage}</h4>
                  </div>
                  <span className={completed.length===round.matches.length ? 'badge green' : 'badge'}>
                    {completed.length}/{round.matches.length} matches complete
                  </span>
                </div>

                <div className="history-match-list">
                  {round.matches.map(m => {
                    const isThird=m.stage==='Final' && m.match_no===3;
                    const score=m.games?.length ? m.games.map(g=>g.side_a_score+'-'+g.side_b_score).join(' · ') : 'BYE';
                    return <div className="history-match" key={'history-match-'+m.id}>
                      <div className="history-match-code">{m.match_code || 'Match '+m.match_no}</div>
                      <div className="history-players">
                        <b>{m.side_a}</b>
                        <span>VS</span>
                        <b>{m.side_b}</b>
                      </div>
                      <div className="history-match-meta">
                        <span>{isThird ? '3rd Place Match' : (m.stage || round.stage)}</span>
                        <span>{m.court ? 'Court '+m.court : 'Court not assigned'}</span>
                        <span>{m.status === 'Completed' ? score : 'Pending'}</span>
                      </div>
                      {m.status==='Completed' && <div className="history-winner"><CheckCircle2 size={14}/> Winner: <b>{m.winner}</b>{m.result_updated_at ? ' · '+formatLbaTime(m.result_updated_at) : ''}</div>}
                    </div>;
                  })}
                </div>

                {winners.length>0 && <div className="advancing-box">
                  <b>Winners advancing from Round {round.number}</b>
                  <div>{winners.map((name,i)=><span key={name+i}>{name}</span>)}</div>
                </div>}
              </section>;
            })}
          </section>

          <section className="audit-history">
            <div className="history-heading">
              <div>
                <span className="eyebrow">SYSTEM RECORD</span>
                <h3>Full Tournament History</h3>
                <p>Administrative actions and result records, with all timestamps shown in Lesotho time.</p>
              </div>
            </div>
            <div className="audit-list">
              {(detail.history || []).map(h => {
                let display=h.details || '';
                try {
                  const parsed=JSON.parse(display);
                  if (parsed && parsed.games) {
                    const scores=parsed.games.map(g=>'Game '+g.game+': '+g.a+'-'+g.b).join(' · ');
                    display=(parsed.winner ? 'Winner: '+parsed.winner+' · ' : '')+scores;
                  } else if (parsed && parsed.previous && parsed.games) {
                    display='Winner: '+(parsed.winner || '—')+' · '+parsed.games.map(g=>'Game '+g.game+': '+g.a+'-'+g.b).join(' · ');
                  }
                } catch (_) {}
                return <div className="audit-row" key={h.id}>
                  <b>{h.action.replaceAll('_',' ')}</b>
                  <small>{formatLbaTime(h.created_at)} · Recorded by: {h.actor}</small>
                  <span className="audit-detail">{display}</span>
                </div>;
              })}
              {!detail.history?.length&&<div className="empty small">No tournament history yet.</div>}
            </div>
          </section>
        </div>}
      </>}
    </div>
  </section>;
}

function Reports() {
  return <section className="panel"><h3>Reports</h3><div className="report-grid"><div><h4>Official Ranking Register</h4><p>Use Export CSV for Excel-ready records.</p></div><div><h4>Tournament Draw Sheet</h4><p>Select attending players, generate a draw, then print the browser page.</p></div><div><h4>Player Activity Summary</h4><p>Use category and status filters to review participation.</p></div></div></section>;
}

function Stat({ label, value }) { return <div className="stat"><span>{label}</span><b>{value}</b></div>; }
function Input({ label, value, onChange, type = 'text' }) { return <label><span>{label}</span><input type={type} value={value ?? ''} onChange={e => onChange(e.target.value)} /></label>; }

createRoot(document.getElementById('root')).render(<App />);
