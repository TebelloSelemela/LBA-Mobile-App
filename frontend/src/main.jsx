import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Download, FileText, Lock, Plus, RefreshCw, Search, Shuffle, Trash2, Trophy, Upload, Users, Home, Menu, X, Sun, Moon, ShieldCheck } from 'lucide-react';
import './style.css';
import logo from './assets/lba-logo.png';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:5050/api';

function getToken() {
  return localStorage.getItem('lba_token') || '';
}

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
  const [currentUser, setCurrentUser] = useState(() => { try { return JSON.parse(localStorage.getItem('lba_user') || 'null'); } catch { return null; } });
  const [activeTab, setActiveTab] = useState('home');
  const [theme, setTheme] = useState(localStorage.getItem('lba_theme') || 'dark');
  const [menuOpen, setMenuOpen] = useState(false);
  const [booting, setBooting] = useState(true);
  const [login, setLogin] = useState({ username: 'admin', password: '' });
  const [message, setMessage] = useState('Welcome to the LBA administration system.');
  const [dashboard, setDashboard] = useState(null);
  const [players, setPlayers] = useState([]);
  const [draws, setDraws] = useState([]);
  const [form, setForm] = useState(emptyForm());
  const [filters, setFilters] = useState({ q: '', category: 'All', status: 'All' });
  const [pointInputs, setPointInputs] = useState({});
  const [drawForm, setDrawForm] = useState({ title: 'LBA Tournament Draw', category_code: 'All', draw_type: 'Singles', seed_by_rank: false, player_ids: [] });

  async function loadAll() {
    if (!getToken()) return;
    const params = new URLSearchParams(filters).toString();
    try {
      const [dashboardData, playerData, drawData] = await Promise.all([
        api('/dashboard'),
        api(`/players?${params}`),
        api('/draws')
      ]);
      setDashboard(dashboardData);
      setPlayers(playerData);
      setDraws(drawData);
    } catch (err) {
      if (err.status === 401) { localStorage.removeItem('lba_token'); localStorage.removeItem('lba_user'); setToken(''); setCurrentUser(null); setMessage('Your session has expired. Please sign in again.'); } else setMessage(err.message);
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
      localStorage.setItem('lba_token', data.token);
      localStorage.setItem('lba_user', JSON.stringify(data.user));
      setToken(data.token);
      setCurrentUser(data.user);
      setMessage(`Welcome, ${data.user.full_name}.`);
    } catch (err) {
      setMessage(err.message || 'Failed to login.');
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

  function logout() {
    localStorage.removeItem('lba_token');
    setToken('');
  }

  if (!token) {
    return <><LoginScreen login={login} setLogin={setLogin} doLogin={doLogin} message={message} />{booting && <BootSplash />}</>;
  }

  return (
    <>
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <div className="brand"><img src={logo} alt="Lesotho Badminton Association logo" className="brand-logo" /><div><h1>Badminton Admin</h1><p>Lesotho Badminton Association</p></div><button className="close-menu" onClick={() => setMenuOpen(false)}><X size={20}/></button></div>
        {[
          ['home','Overview',Home],['records','Records',Users],['draws','Draws',Shuffle],['reports','Reports',Trophy]
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
        {activeTab === 'reports' && <Reports />}
      </main>
      <nav className="mobile-nav">{[["home","Home",Home],["records","Players",Users],["draws","Draws",Shuffle],["reports","Reports",Trophy]].map(([id,label,Icon])=><button key={id} className={activeTab===id?"active":""} onClick={()=>setActiveTab(id)}><Icon size={19}/><span>{label}</span></button>)}</nav>
    </div>
    {booting && <BootSplash />}
    </>
  );
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

function LoginScreen({ login, setLogin, doLogin, message }) {
  return <div className="login-page"><form className="login-card" onSubmit={doLogin}><img src={logo} alt="Lesotho Badminton Association logo" className="login-logo" /><div className="lock"><Lock /></div><h1>LBA Admin Login</h1><p>Use your local admin credentials to access ranking records.</p><input placeholder="Username or email" value={login.username} onChange={e => setLogin({ ...login, username: e.target.value })}/><input placeholder="Password" type="password" value={login.password} onChange={e => setLogin({ ...login, password: e.target.value })}/><button className="button full">Login</button><small>{message}</small></form></div>;
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

function Reports() {
  return <section className="panel"><h3>Reports</h3><div className="report-grid"><div><h4>Official Ranking Register</h4><p>Use Export CSV for Excel-ready records.</p></div><div><h4>Tournament Draw Sheet</h4><p>Select attending players, generate a draw, then print the browser page.</p></div><div><h4>Player Activity Summary</h4><p>Use category and status filters to review participation.</p></div></div></section>;
}

function Stat({ label, value }) { return <div className="stat"><span>{label}</span><b>{value}</b></div>; }
function Input({ label, value, onChange, type = 'text' }) { return <label><span>{label}</span><input type={type} value={value ?? ''} onChange={e => onChange(e.target.value)} /></label>; }

createRoot(document.getElementById('root')).render(<App />);
