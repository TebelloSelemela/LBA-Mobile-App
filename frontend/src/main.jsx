import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Download, FileText, Lock, Plus, RefreshCw, Search, Shuffle, Trash2, Trophy, Upload, Users, Home, Menu, X, Sun, Moon, ShieldCheck, CalendarDays, CheckCircle2, ClipboardList, MonitorPlay, Maximize, Minimize, TrendingUp, Activity, UserRound, BarChart3, Archive } from 'lucide-react';
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

function calculateAgeFromDob(dateOfBirth) {
  if (!dateOfBirth) return null;
  const parts=String(dateOfBirth).split('-').map(Number);
  if (parts.length!==3 || parts.some(Number.isNaN)) return null;
  const [year,month,day]=parts;
  const today=new Date();
  let age=today.getFullYear()-year;
  if ((today.getMonth()+1)<month || ((today.getMonth()+1)===month && today.getDate()<day)) age-=1;
  return age>=0 && age<=120 ? age : null;
}

function automaticAgeGroup(age) {
  if (age===null || age===undefined) return '';
  if (age<=10) return 'U11';
  if (age<=12) return 'U13';
  if (age<=14) return 'U15';
  if (age<=16) return 'U17';
  return '18+';
}

function automaticCategory(gender, ageGroup) {
  if (!ageGroup) return '';
  const value=String(gender || '').toLowerCase();
  if (['men','male','boy','boys'].includes(value)) return 'MS,'+ageGroup;
  if (['women','woman','female','girl','girls'].includes(value)) return 'WS,'+ageGroup;
  return '';
}

function applyPlayerClassification(current, changes={}) {
  const next={...current,...changes};
  const age=calculateAgeFromDob(next.date_of_birth);
  if (age===null) return {...next,age:null,age_group:'',category_code:''};
  const age_group=automaticAgeGroup(age);
  const category_code=automaticCategory(next.gender,age_group);
  return {...next,age,age_group,category_code};
}

function doublesGenderBucket(player) {
  const gender=String(player?.gender || '').trim().toLowerCase();
  const eventType=String(player?.event_type || '').trim().toLowerCase();
  if (['men','male','boys','boy'].includes(gender) || eventType.includes("men's") || eventType.includes('boys')) return 'M';
  if (['women','female','girls','girl'].includes(gender) || eventType.includes("women's") || eventType.includes('girls')) return 'W';
  return 'O';
}

const OPERATIONAL_AGE_GROUPS=['U11','U13','U15','U17','18+'];

function isSpecialJuniorCategory(value) {
  return String(value || '').trim().toUpperCase().includes('JUNIOR');
}

function doublesAgeGroup(player) {
  const numericAge=Number(player?.age);
  if (Number.isFinite(numericAge) && numericAge>=0) return automaticAgeGroup(numericAge);

  const category=String(player?.category_code || '').trim().toUpperCase();
  const categoryMatch=category.match(/U11|U13|U15|U17|18\+/);
  if (categoryMatch) return categoryMatch[0];

  const saved=String(player?.age_group || '').trim().toUpperCase();
  return OPERATIONAL_AGE_GROUPS.includes(saved) ? saved : 'Open';
}

function playerMatchesDoublesAge(player, selectedAge) {
  return !selectedAge || selectedAge === 'All' || doublesAgeGroup(player) === String(selectedAge).toUpperCase();
}

function doublesAgeOptions(players, eventName) {
  const event=String(eventName || '').toUpperCase();
  const counts={};
  (players || []).forEach(player=>{
    if (player.status && player.status !== 'Active') return;
    const bucket=doublesGenderBucket(player);
    if (!['M','W'].includes(bucket)) return;
    const age=doublesAgeGroup(player);
    if (!OPERATIONAL_AGE_GROUPS.includes(age)) return;
    if (!counts[age]) counts[age]={M:0,W:0};
    counts[age][bucket]+=1;
  });
  const eligible=OPERATIONAL_AGE_GROUPS.filter(age=>{
    const count=counts[age] || {M:0,W:0};
    if (event==='MD') return count.M>=1;
    if (event==='WD') return count.W>=1;
    if (event==='XD') return count.M>=1 && count.W>=1;
    return count.M+count.W>0;
  });
  return ['All',...eligible];
}

function emptyForm() {
  return {
    full_name: '',
    first_name: '',
    last_name: '',
    category_code: '',
    gender: 'Men',
    age_group: '',
    date_of_birth: '',
    age: null,
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
    players.forEach(player => player.category_code && !isSpecialJuniorCategory(player.category_code) && values.add(player.category_code));
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
    if (!form.date_of_birth) {
      setMessage('Enter the player’s date of birth. Age group and category are calculated automatically.');
      return;
    }
    try {
      const method = form.id ? 'PUT' : 'POST';
      const path = form.id ? `/players/${form.id}` : '/players';
      const saved=await api(path, { method, body: JSON.stringify(form) });
      setForm(emptyForm());
      setMessage(`${saved.full_name} saved as ${saved.category_code} · ${saved.age_group} · age ${saved.age}.`);
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
        {activeTab === 'records' && <Records players={players} form={form} setForm={setForm} savePlayer={savePlayer} deletePlayer={deletePlayer} filters={filters} setFilters={setFilters} categoryOptions={categoryOptions} loadAll={loadAll} pointInputs={pointInputs} setPointInputs={setPointInputs} addPoints={addPoints} setMessage={setMessage} />}
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
  const [tournamentDetail, setTournamentDetail] = useState(null);
  const [revealing, setRevealing] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [viewMode, setViewMode] = useState('draw');
  const [projectorBracketZoom, setProjectorBracketZoom] = useState(1);

  useEffect(() => {
    if (!selectedId && draws[0]) setSelectedId(draws[0].id);
  }, [draws, selectedId]);

  useEffect(() => {
    let cancelled=false;
    if (!selectedId) {
      setFull(null);
      setTournamentDetail(null);
      return () => {};
    }
    api('/draws/'+selectedId).then(async drawData => {
      if (cancelled) return;
      setFull(drawData);
      if (drawData?.tournament_id) {
        try {
          const detail=await api('/tournaments/'+drawData.tournament_id);
          if (!cancelled) setTournamentDetail(detail);
        } catch {
          if (!cancelled) setTournamentDetail(null);
        }
      } else {
        setTournamentDetail(null);
      }
    }).catch(() => {
      if (!cancelled) {
        setFull(null);
        setTournamentDetail(null);
      }
    });
    return () => { cancelled=true; };
  }, [selectedId]);

  useEffect(() => {
    const sync=()=>setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange',sync);
    return ()=>document.removeEventListener('fullscreenchange',sync);
  }, []);

  const draw = full || draws.find(d => d.id === selectedId) || draws[0];
  const matches = draw?.matches || [];
  const eventName=(draw?.event_name || draw?.category_code || 'MS').toUpperCase();
  const tournamentName = tournamentDetail?.name || draw?.title || 'LBA Tournament Draw';

  const projectorBracketModel = useMemo(() => {
    if (!draw) return null;
    const source=(tournamentDetail?.matches || matches || [])
      .filter(m => !tournamentDetail || (m.event_name || 'MS').toUpperCase() === eventName);
    if (!source.length) return null;

    const byRound={};
    source.forEach(m => {
      const rn=Number(m.round_number || 1);
      if (!byRound[rn]) byRound[rn]=[];
      byRound[rn].push(m);
    });
    Object.values(byRound).forEach(list=>list.sort((a,b)=>Number(a.match_no||0)-Number(b.match_no||0)));

    const first=(byRound[1] || []).filter(m => !(m.stage==='Final' && Number(m.match_no)===3));
    const firstCount=first.length;
    if (!firstCount) return null;

    const totalRounds=Math.floor(Math.log2(firstCount))+1;
    const stageForSlots=slots=>({2:'Final',4:'Semifinal',8:'Quarterfinal',16:'Round of 16',32:'Round of 32',64:'Round of 64',128:'Round of 128'}[slots] || ('Round of '+slots));
    const columns=[];

    for(let r=0;r<totalRounds;r++){
      const expected=Math.max(1,Math.floor(firstCount/(2**r)));
      const actual=(byRound[r+1] || []).filter(m => !(m.stage==='Final' && Number(m.match_no)===3));
      const stage=stageForSlots(expected*2);
      const colMatches=Array.from({length:expected},(_,i)=>{
        if(actual[i]) return {...actual[i],virtual:false};
        return {
          id:'projector-standby-'+eventName+'-'+r+'-'+i,
          match_no:i+1,
          match_code:'STANDBY '+(i+1),
          side_a:'Winner of previous match '+(i*2+1),
          side_b:'Winner of previous match '+(i*2+2),
          status:'Standby',
          winner:null,
          games:[],
          virtual:true
        };
      });
      columns.push({number:r+1,stage,matches:colMatches});
    }
    return {firstCount,columns};
  }, [draw, tournamentDetail, matches, eventName]);

  const projectorBracketGeometry = useMemo(() => {
    if (!projectorBracketModel) return null;
    const colWidth=285, gap=100, unit=118, cardHeight=94, topOffset=54;
    const width=projectorBracketModel.columns.length*colWidth + Math.max(0,projectorBracketModel.columns.length-1)*gap;
    const height=Math.max(170,projectorBracketModel.firstCount*unit)+topOffset;
    const cardPosition=(roundIndex,matchIndex)=>{
      const center=topOffset+(matchIndex+0.5)*(2**roundIndex)*unit;
      return {x:roundIndex*(colWidth+gap),y:center-cardHeight/2,center};
    };
    const paths=[];
    projectorBracketModel.columns.slice(0,-1).forEach((column,r)=>{
      column.matches.forEach((_,i)=>{
        const from=cardPosition(r,i);
        const to=cardPosition(r+1,Math.floor(i/2));
        const x1=from.x+colWidth, x2=to.x, mid=x1+gap/2;
        paths.push({key:'projector-'+r+'-'+i,d:'M '+x1+' '+from.center+' H '+mid+' V '+to.center+' H '+x2});
      });
    });
    return {colWidth,gap,unit,cardHeight,topOffset,width,height,cardPosition,paths};
  }, [projectorBracketModel]);

  async function toggleFullscreen() {
    try {
      const presentation=document.getElementById('projector-presentation');
      if (!document.fullscreenElement) {
        if (presentation?.requestFullscreen) await presentation.requestFullscreen();
        else await document.documentElement.requestFullscreen();
        window.setTimeout(()=>fitProjectorBracket(),180);
      } else {
        await document.exitFullscreen();
      }
    } catch {}
  }

  function fitProjectorBracket() {
    if (!projectorBracketGeometry) return;
    window.requestAnimationFrame(()=>{
      const stage=document.querySelector('.projector-bracket-stage');
      if (!stage) return;
      const availableWidth=Math.max(320,stage.clientWidth-42);
      const availableHeight=Math.max(260,stage.clientHeight-38);
      const scale=Math.min(availableWidth/projectorBracketGeometry.width,availableHeight/projectorBracketGeometry.height);
      const next=Math.max(0.38,Math.min(1.35,scale));
      setProjectorBracketZoom(Math.round(next*100)/100);
    });
  }

  function changeProjectorBracketZoom(delta) {
    setProjectorBracketZoom(z=>Math.max(0.38,Math.min(1.5,Math.round((z+delta)*100)/100)));
  }

  useEffect(() => {
    if (viewMode==='bracket' && projectorBracketGeometry) {
      const timer=window.setTimeout(()=>fitProjectorBracket(),100);
      return ()=>window.clearTimeout(timer);
    }
  }, [viewMode, selectedId, projectorBracketGeometry]);

  function revealDraw() {
    setViewMode('draw');
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
        <h2>Projector Presentation</h2>
        <p>Present either the generated match list or the full live knockout bracket to players and officials.</p>
      </div>
      <div className="projector-toolbar-controls">
        <select value={selectedId || ''} onChange={e => {setSelectedId(Number(e.target.value));setRevealed(false);}}>
          {!draws.length && <option value="">No draws available</option>}
          {draws.map(d => <option key={d.id} value={d.id}>{d.title} · {(d.event_name || d.category_code || '').toUpperCase()}</option>)}
        </select>
        <div className="projector-view-tabs">
          <button type="button" className={viewMode==='draw'?'active':''} onClick={()=>setViewMode('draw')}><Shuffle size={15}/> Draw View</button>
          <button type="button" className={viewMode==='bracket'?'active':''} onClick={()=>setViewMode('bracket')} disabled={!projectorBracketModel}><Trophy size={15}/> Bracket View</button>
        </div>
        <button className="button" onClick={revealDraw} disabled={!matches.length || revealing}>
          <Shuffle size={16}/> {revealing ? 'Revealing…' : 'Reveal Draw'}
        </button>
        <button className="button secondary" onClick={toggleFullscreen}>
          {isFullscreen ? <Minimize size={16}/> : <Maximize size={16}/>} {isFullscreen ? 'Exit Fullscreen' : 'Projector Fullscreen'}
        </button>
      </div>
    </div>

    {!draw ? <div className="projector-empty"><MonitorPlay size={60}/><h2>No draw available</h2><p>Generate a draw first, then return here to present it.</p></div> :
      <div className={'projector-board projector-mode-'+viewMode} id="projector-presentation">
        <div className="projector-title">
          <img src={logo} alt="LBA" />
          <div>
            <span>LESOTHO BADMINTON ASSOCIATION</span>
            <h1>{tournamentName}</h1>
            <p>{eventName} · {viewMode==='bracket' ? 'LIVE KNOCKOUT BRACKET' : ((draw.draw_type || 'Draw')+' · '+matches.length+' matches · '+(revealed ? 'DRAW REVEALED' : 'READY TO REVEAL'))}</p>
          </div>
          {viewMode==='bracket' && projectorBracketGeometry && <div className="projector-bracket-tools">
            <button type="button" onClick={()=>changeProjectorBracketZoom(-0.08)}>−</button>
            <b>{Math.round(projectorBracketZoom*100)}%</b>
            <button type="button" onClick={()=>changeProjectorBracketZoom(0.08)}>+</button>
            <button type="button" onClick={fitProjectorBracket}>Fit</button>
          </div>}
        </div>

        {viewMode==='draw' && <>
          {revealing && <div className="draw-reveal-animation">
            <Shuffle size={54}/><b>SHUFFLING PLAYERS…</b><span>Random draw generated by the tournament system</span>
          </div>}
          {!revealing && <div className="projector-matches">
            {matches.map(m => <div className="projector-match" key={m.id}>
              <span className="projector-match-no">MATCH {m.match_no}</span>
              <div><strong>{revealed ? m.side_a : 'PLAYER A'}</strong><em>VS</em><strong>{revealed ? m.side_b : 'PLAYER B'}</strong></div>
            </div>)}
          </div>}
        </>}

        {viewMode==='bracket' && <div className="projector-bracket-stage">
          {!projectorBracketModel || !projectorBracketGeometry ? <div className="projector-empty compact"><Trophy size={46}/><h2>Bracket unavailable</h2><p>This draw does not contain enough match information to build a bracket.</p></div> :
          <div className="projector-bracket-scroll">
            <div className="projector-bracket-zoom-shell" style={{width:projectorBracketGeometry.width*projectorBracketZoom,height:projectorBracketGeometry.height*projectorBracketZoom}}>
              <div className="projector-bracket-canvas" style={{width:projectorBracketGeometry.width,height:projectorBracketGeometry.height,transform:'scale('+projectorBracketZoom+')',transformOrigin:'top left'}}>
                <svg className="projector-bracket-connectors" width={projectorBracketGeometry.width} height={projectorBracketGeometry.height} viewBox={'0 0 '+projectorBracketGeometry.width+' '+projectorBracketGeometry.height} aria-hidden="true">
                  {projectorBracketGeometry.paths.map(p=><path key={p.key} d={p.d}/>)}
                </svg>
                {projectorBracketModel.columns.map((column,r)=>{
                  const x=r*(projectorBracketGeometry.colWidth+projectorBracketGeometry.gap);
                  const completed=column.matches.filter(m=>m.status==='Completed').length;
                  return <React.Fragment key={'projector-column-'+r}>
                    <div className="projector-bracket-stage-title" style={{left:x,width:projectorBracketGeometry.colWidth}}>
                      <b>{column.stage}</b><span>{completed}/{column.matches.length}</span>
                    </div>
                    {column.matches.map((m,i)=>{
                      const pos=projectorBracketGeometry.cardPosition(r,i);
                      const scores=m.games?.length ? m.games.map(g=>g.side_a_score+'-'+g.side_b_score).join(' · ') : '';
                      const state=m.virtual ? 'standby' : (m.status==='Completed' ? 'complete' : (m.status==='In Progress' ? 'progress' : 'pending'));
                      return <div className={'projector-bracket-match '+state} style={{left:pos.x,top:pos.y,width:projectorBracketGeometry.colWidth}} key={'projector-path-'+m.id}>
                        <small>{m.match_code || ('M'+m.match_no)} · {m.virtual ? 'STANDBY' : (m.status==='Completed' ? 'RESULT' : (m.status==='In Progress' ? 'LIVE' : 'READY'))}</small>
                        <div className={m.winner===m.side_a?'winner':''}><span>{m.side_a}</span>{m.winner===m.side_a&&<b>✓</b>}</div>
                        <div className={m.winner===m.side_b?'winner':''}><span>{m.side_b}</span>{m.winner===m.side_b&&<b>✓</b>}</div>
                        {scores&&<em>{scores}</em>}
                      </div>;
                    })}
                  </React.Fragment>;
                })}
              </div>
            </div>
          </div>}
        </div>}

        <div className="projector-footer">
          <span>Generated by LBA Tournament System</span>
          <span>{tournamentDetail?.venue ? tournamentDetail.venue+' · ' : ''}{eventName} · {draw.created_at || ''}</span>
        </div>
      </div>}
  </section>;
}


function Overview({ dashboard, players, draws, setActiveTab, exportFile }) {
  const [insightTab, setInsightTab] = useState('players');
  const top = dashboard?.topPlayers || [];
  const categories = dashboard?.categoryBreakdown || [];
  const insights = dashboard?.insights || {};
  const pulse = dashboard?.tournamentPulse || {};
  const completionRate = pulse.totalMatches ? Math.round((Number(pulse.completedMatches || 0) / Number(pulse.totalMatches || 1)) * 100) : 0;

  const insightCards = [
    {
      key:'rising',
      icon:<TrendingUp size={18}/>,
      label:'Rising player',
      value:insights.risingPlayer?.full_name || 'Not enough data',
      meta:insights.risingPlayer ? '+'+Number(insights.risingPlayer.points_gain_90d || 0).toLocaleString()+' pts in the last 90 days' : 'Add tournament points to build this insight.',
      detail:insights.risingPlayer ? [insights.risingPlayer.category_code,insights.risingPlayer.club || 'Independent'].filter(Boolean).join(' · ') : ''
    },
    {
      key:'form',
      icon:<Activity size={18}/>,
      label:'In-form player',
      value:insights.inFormPlayer?.full_name || 'Not enough match data',
      meta:insights.inFormPlayer ? insights.inFormPlayer.win_rate+'% win rate · '+insights.inFormPlayer.recent_wins+'/'+insights.inFormPlayer.recent_matches+' recent matches' : 'At least two completed matches are needed.',
      detail:insights.inFormPlayer ? [insights.inFormPlayer.category_code,insights.inFormPlayer.club || 'Independent'].filter(Boolean).join(' · ') : ''
    },
    {
      key:'youngest',
      icon:<UserRound size={18}/>,
      label:'Youngest player',
      value:insights.youngestPlayer?.full_name || 'DOB unavailable',
      meta:insights.youngestPlayer?.age_basis || 'Add date of birth to player records.',
      detail:insights.youngestPlayer ? [insights.youngestPlayer.category_code,insights.youngestPlayer.club || 'Independent'].filter(Boolean).join(' · ') : ''
    },
    {
      key:'active',
      icon:<BarChart3 size={18}/>,
      label:'Most active player',
      value:insights.mostActivePlayer?.full_name || 'No tournament history yet',
      meta:insights.mostActivePlayer ? Number(insights.mostActivePlayer.tournaments_played || 0)+' tournaments recorded' : 'Tournament participation will appear here.',
      detail:insights.mostActivePlayer ? [insights.mostActivePlayer.category_code,Number(insights.mostActivePlayer.total_points || 0).toLocaleString()+' pts'].filter(Boolean).join(' · ') : ''
    }
  ];

  const pulseCards = [
    {label:'Live tournaments',value:Number(pulse.liveTournaments || 0),meta:Number(pulse.totalTournaments || 0)+' tournament records'},
    {label:'Tournament events',value:Number(pulse.events || 0),meta:'MS, WS, MD, WD and XD draws'},
    {label:'Matches complete',value:completionRate+'%',meta:Number(pulse.completedMatches || 0)+' of '+Number(pulse.totalMatches || 0)+' matches'},
    {label:'Matches live now',value:Number(pulse.liveMatches || 0),meta:Number(pulse.completedTournaments || 0)+' tournaments completed'}
  ];

  return <section className="overview-page">
    <section className="welcome-card"><div><span className="eyebrow">LESOTHO BADMINTON ASSOCIATION</span><h2>Committee dashboard</h2><p>Manage the player register, rankings and live tournament operations from one professional workspace.</p><div className="quick-actions"><button className="button" onClick={() => setActiveTab('records')}><Users size={16}/> Player register</button><button className="button secondary" onClick={() => setActiveTab('tournaments')}><Trophy size={16}/> Tournament centre</button><button className="button secondary" onClick={() => exportFile('/players/export.xlsx','lba_players.xlsx')}><FileText size={16}/> Export players</button></div></div><div className="court-badge"><span>🏸</span><b>PLAY</b><b>RANK</b><b>GROW</b></div></section>

    <section className="stats overview-stats"><Stat label="Registered players" value={dashboard?.totalPlayers ?? 0}/><Stat label="Active players" value={dashboard?.activePlayers ?? 0}/><Stat label="Categories" value={dashboard?.categories ?? 0}/><Stat label="Saved draws" value={dashboard?.draws ?? 0}/></section>

    <section className="panel smart-insights">
      <div className="smart-insights-head">
        <div><span className="eyebrow">SMART ANALYTICS</span><h3>Association insights</h3><p>Built from the player register, ranking updates and completed tournament matches.</p></div>
        <div className="insight-tabs">
          <button type="button" className={insightTab==='players'?'active':''} onClick={()=>setInsightTab('players')}>Player form</button>
          <button type="button" className={insightTab==='tournaments'?'active':''} onClick={()=>setInsightTab('tournaments')}>Tournament pulse</button>
        </div>
      </div>

      {insightTab==='players' ? <>
        <div className="insight-grid">
          {insightCards.map(card=><div className="insight-card" key={card.key}>
            <div className="insight-icon">{card.icon}</div>
            <div className="insight-copy"><small>{card.label}</small><b>{card.value}</b><span>{card.meta}</span>{card.detail&&<em>{card.detail}</em>}</div>
          </div>)}
        </div>
        <p className="analytics-note">“Rising player” uses positive points added in the last 90 days. “In-form player” uses recent completed match results. “Youngest player” uses exact date of birth where it has been recorded.</p>
      </> : <div className="pulse-grid">
        {pulseCards.map(card=><div className="pulse-card" key={card.label}><small>{card.label}</small><strong>{card.value}</strong><span>{card.meta}</span></div>)}
      </div>}
    </section>

    <section className="dashboard-grid">
      <div className="panel">
        <div className="section-head"><div><span className="eyebrow">RANKING SNAPSHOT</span><h3>Leading players</h3></div><button className="text-btn" onClick={() => setActiveTab('records')}>View register</button></div>
        <div className="ranking-list">{top.map((p,i)=><div className="rank-row" key={p.id}><strong className={'rank-no rank-'+(i+1)}>{i+1}</strong><div className="avatar">{p.full_name.split(' ').map(x=>x[0]).slice(0,2).join('')}</div><div className="rank-name"><b>{p.full_name}</b><small>{p.category_code} · {p.club || 'Independent'}</small></div><strong>{Number(p.total_points || 0).toLocaleString()}<small>points</small></strong></div>)}{!top.length&&<div className="empty">No ranking records yet.</div>}</div>
      </div>

      <div className="panel">
        <div className="section-head"><div><span className="eyebrow">PARTICIPATION</span><h3>Categories</h3></div></div>
        <div className="category-list">{categories.map(c=><div className="category-row" key={[c.category_code,c.event_type,c.age_group].join('-')}><div><b>{c.category_code}</b><small>{[c.event_type,c.age_group].filter(Boolean).join(' · ')}</small></div><strong>{c.player_count}</strong></div>)}</div>
        {!categories.length&&<div className="empty">Import player records to see category activity.</div>}
      </div>
    </section>

    <section className="panel feature-strip"><div><Trophy size={20}/><div><b>Tournament operations</b><span>{draws.length ? draws.length+' draw record(s) are available. Use Tournament Centre for live results, progression and reporting.' : 'Create a tournament when attendance is confirmed, then run each event from Round 1 to the Final.'}</span></div></div><button className="button" onClick={() => setActiveTab('tournaments')}>Open Tournament Centre</button></section>
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


function Records({ players, form, setForm, savePlayer, deletePlayer, filters, setFilters, categoryOptions, loadAll, pointInputs, setPointInputs, addPoints, setMessage }) {
  const [recordView, setRecordView] = useState('players');
  const [doublesEvent, setDoublesEvent] = useState('All');
  const [doublesTeams, setDoublesTeams] = useState([]);
  const [loadingDoubles, setLoadingDoubles] = useState(false);
  const [doublesPointInputs, setDoublesPointInputs] = useState({});
  const [doublesPlayers, setDoublesPlayers] = useState([]);
  const [showDoublesEditor, setShowDoublesEditor] = useState(false);
  const [doublesTeamForm, setDoublesTeamForm] = useState({id:null,event_name:'MD',age_group:'All',player_a_id:'',player_b_id:'',team_name:''});

  async function loadDoublesTeams(event=doublesEvent) {
    setLoadingDoubles(true);
    try {
      const suffix=event && event!=='All' ? '?event='+encodeURIComponent(event) : '';
      const rows=await api('/doubles/teams'+suffix);
      setDoublesTeams(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setDoublesTeams([]);
      if (setMessage) setMessage(e.message || 'Could not load doubles team records.');
    } finally {
      setLoadingDoubles(false);
    }
  }

  useEffect(() => {
    if (recordView === 'doubles') {
      loadDoublesTeams(doublesEvent);
      api('/players?category=All&status=Active')
        .then(rows=>setDoublesPlayers(Array.isArray(rows)?rows:[]))
        .catch(()=>setDoublesPlayers([]));
    }
  }, [recordView, doublesEvent]);

  function resetDoublesTeamEditor() {
    setDoublesTeamForm({id:null,event_name:'MD',age_group:'All',player_a_id:'',player_b_id:'',team_name:''});
    setShowDoublesEditor(false);
  }

  function startAddDoublesTeam() {
    const event=['MD','WD','XD'].includes(doublesEvent) ? doublesEvent : 'MD';
    setDoublesTeamForm({id:null,event_name:event,age_group:'All',player_a_id:'',player_b_id:'',team_name:''});
    setShowDoublesEditor(true);
  }

  function editDoublesTeam(team) {
    let aId=String(team.player_a_id || ''), bId=String(team.player_b_id || '');
    if (team.event_name==='XD' && String(team.player_a_gender || '').toLowerCase().startsWith('w')) {
      [aId,bId]=[bId,aId];
    }
    const ageA=String(team.player_a_age_group || '');
    const ageB=String(team.player_b_age_group || '');
    setDoublesTeamForm({
      id:team.id,
      event_name:team.event_name,
      age_group:ageA && ageA===ageB ? ageA : 'All',
      player_a_id:aId,
      player_b_id:bId,
      team_name:team.team_name || ''
    });
    setShowDoublesEditor(true);
  }

  async function saveDoublesTeam(e) {
    e.preventDefault();
    const f=doublesTeamForm;
    if (!f.player_a_id || !f.player_b_id) {
      if (setMessage) setMessage('Select both partners for the doubles team.');
      return;
    }
    try {
      const path=f.id ? '/doubles/teams/'+f.id : '/doubles/teams';
      const method=f.id ? 'PUT' : 'POST';
      const saved=await api(path,{
        method,
        body:JSON.stringify({
          event_name:f.event_name,
          age_group:f.age_group,
          player_a_id:Number(f.player_a_id),
          player_b_id:Number(f.player_b_id),
          team_name:f.team_name
        })
      });
      if (doublesEvent!=='All' && doublesEvent!==f.event_name) setDoublesEvent(f.event_name);
      else await loadDoublesTeams(doublesEvent);
      resetDoublesTeamEditor();
      if (setMessage) setMessage((f.id?'Updated ':'Added ')+(saved.team_name || 'doubles team')+'.');
    } catch (e) {
      if (setMessage) setMessage(e.message || 'Could not save doubles team.');
    }
  }

  async function archiveDoublesTeam(team) {
    const label=team.team_name || [team.player_a_name,team.player_b_name].filter(Boolean).join(' / ');
    if (!window.confirm('Delete '+label+' from active Doubles Team Records? Historical tournament matches and results will remain intact.')) return;
    try {
      await api('/doubles/teams/'+team.id,{method:'DELETE'});
      await loadDoublesTeams(doublesEvent);
      if (setMessage) setMessage(label+' deleted from active doubles team records.');
    } catch (e) {
      if (setMessage) setMessage(e.message || 'Could not delete doubles team.');
    }
  }

  async function addDoublesPoints(team) {
    const raw=doublesPointInputs[team.id];
    const points=Number(raw);
    if (!raw || Number.isNaN(points)) {
      if (setMessage) setMessage('Enter valid doubles points for '+team.team_name+'.');
      return;
    }
    try {
      const data=await api('/doubles/teams/'+team.id+'/points',{
        method:'POST',
        body:JSON.stringify({points_delta:points,notes:'Latest doubles tournament points'})
      });
      setDoublesPointInputs(current=>({...current,[team.id]:''}));
      await loadDoublesTeams(doublesEvent);
      if (setMessage) setMessage(team.team_name+': '+data.old_points+' + '+data.added_points+' = '+data.new_points+' doubles points.');
    } catch (e) {
      if (setMessage) setMessage(e.message || 'Could not add doubles points.');
    }
  }

  const doublesEditorAgeOptions=useMemo(
    ()=>doublesAgeOptions(doublesPlayers,doublesTeamForm.event_name),
    [doublesPlayers,doublesTeamForm.event_name]
  );
  const doublesEditorCandidates=useMemo(
    ()=>(doublesPlayers || []).filter(p=>p.status==='Active' && playerMatchesDoublesAge(p,doublesTeamForm.age_group)),
    [doublesPlayers,doublesTeamForm.age_group]
  );
  const doublesEditorPartnerA=useMemo(()=>{
    const event=doublesTeamForm.event_name;
    if (event==='MD') return doublesEditorCandidates.filter(p=>doublesGenderBucket(p)==='M');
    if (event==='WD') return doublesEditorCandidates.filter(p=>doublesGenderBucket(p)==='W');
    return doublesEditorCandidates.filter(p=>doublesGenderBucket(p)==='M');
  },[doublesEditorCandidates,doublesTeamForm.event_name]);
  const doublesEditorPartnerB=useMemo(()=>{
    const event=doublesTeamForm.event_name;
    if (event==='MD') return doublesEditorCandidates.filter(p=>doublesGenderBucket(p)==='M');
    if (event==='WD') return doublesEditorCandidates.filter(p=>doublesGenderBucket(p)==='W');
    return doublesEditorCandidates.filter(p=>doublesGenderBucket(p)==='W');
  },[doublesEditorCandidates,doublesTeamForm.event_name]);

  const doublesTotals=doublesTeams.reduce((acc,team)=>{
    acc.points+=Number(team.total_points || 0);
    acc.matches+=Number(team.matches_played || 0);
    acc.wins+=Number(team.wins || 0);
    return acc;
  },{points:0,matches:0,wins:0});

  return <section className="records-page">
    <div className="record-view-tabs" role="tablist" aria-label="Records sections">
      <button type="button" className={recordView==='players'?'active':''} onClick={()=>setRecordView('players')}><Users size={16}/> Players</button>
      <button type="button" className={recordView==='doubles'?'active':''} onClick={()=>setRecordView('doubles')}><Trophy size={16}/> Doubles Teams</button>
    </div>

    {recordView==='players' ? <section className="grid two">
      <div className="panel">
        <h3>{form.id ? 'Update Player' : 'Add Player'}</h3>
        <form onSubmit={savePlayer} className="form">
          <Input label="Full name" value={form.full_name} onChange={v => setForm({ ...form, full_name: v })}/>
          <div className="form-row"><Input label="First name" value={form.first_name} onChange={v => setForm({ ...form, first_name: v })}/><Input label="Last name" value={form.last_name} onChange={v => setForm({ ...form, last_name: v })}/></div>
          <div className="form-row">
            <Input label="Date of birth" type="date" max={new Date().toISOString().slice(0,10)} value={form.date_of_birth} onChange={v => setForm(current=>applyPlayerClassification(current,{date_of_birth:v}))}/>
            <Input label="Calculated age" value={form.age ?? ''} readOnly placeholder="From date of birth"/>
          </div>
          <div className="form-row">
            <label><span>Gender</span><select value={form.gender || 'Men'} onChange={e=>setForm(current=>applyPlayerClassification(current,{gender:e.target.value}))}><option value="Men">Men / Boys</option><option value="Women">Women / Girls</option></select></label>
            <Input label="Club" value={form.club} onChange={v => setForm({ ...form, club: v })}/>
          </div>
          <div className="form-row">
            <Input label="Automatic category" value={form.category_code || 'Enter DOB'} readOnly/>
            <Input label="Automatic age group" value={form.age_group || 'Enter DOB'} readOnly/>
          </div>
          <div className="classification-note"><CheckCircle2 size={15}/><span>Date of birth is the age source. When the player outgrows an age group, the system automatically moves the record to the next category.</span></div>
          <div className="form-row"><Input label="Rank" type="number" value={form.rank_position} onChange={v => setForm({ ...form, rank_position: v })}/><Input label="Total points correction" type="number" value={form.total_points} onChange={v => setForm({ ...form, total_points: v })}/></div>
          <p className="helper">Use the table's “Add points” box to add latest tournament points. Example: 120 + 20 = 140.</p>
          <label><span>Status</span><select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}><option>Active</option><option>Inactive</option></select></label>
          <label><span>Notes</span><textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}/></label>
          <div className="actions"><button className="button"><Plus size={16}/> Save</button><button type="button" className="button secondary" onClick={() => setForm(emptyForm())}>Clear</button></div>
        </form>
      </div>
      <div className="panel wide">
        <div className="toolbar">
          <div className="search"><Search size={16}/><input placeholder="Search player, club or category" value={filters.q} onChange={e => setFilters({ ...filters, q: e.target.value })} onKeyDown={e => e.key === 'Enter' && loadAll()} /></div>
          <select value={filters.category} onChange={e => setFilters({ ...filters, category: e.target.value })}>{categoryOptions.map(c => <option key={c}>{c}</option>)}</select>
          <select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}><option>All</option><option>Active</option><option>Inactive</option></select>
          <button className="icon-btn" onClick={loadAll}><RefreshCw size={16}/></button>
        </div>
        <div className="table-wrap"><table><thead><tr><th>Rank</th><th>Name</th><th>Category</th><th>Club</th><th>Points</th><th>Add latest points</th><th>Status</th><th></th></tr></thead><tbody>{players.map(p => <tr key={p.id}><td>#{p.rank_position || '-'}</td><td><b>{p.full_name}</b><small>{p.gender} · {p.age_group}{p.age!==null && p.age!==undefined ? ' · '+p.age+' yrs' : ' · DOB needed'}</small></td><td>{p.category_code}</td><td>{p.club || '-'}</td><td><b>{p.total_points}</b></td><td><div className="points-add"><input type="number" placeholder="+ points" value={pointInputs[p.id] || ''} onChange={e => setPointInputs(current => ({ ...current, [p.id]: e.target.value }))}/><button className="mini green" onClick={() => addPoints(p)}>Add</button></div></td><td><span className={p.status === 'Active' ? 'badge green' : 'badge'}>{p.status}</span></td><td><button className="mini" onClick={() => setForm({...emptyForm(),...p})}>Edit</button><button className="mini danger" onClick={() => deletePlayer(p.id)}><Trash2 size={14}/></button></td></tr>)}</tbody></table></div>
      </div>
    </section> : <section className="panel doubles-records-page">
      <div className="section-head records-section-head">
        <div><span className="eyebrow">PARTNERSHIP RANKINGS</span><h3>Doubles Team Records</h3><p>MD, WD and XD are ranked independently by doubles points. These points are separate from each player’s singles ranking points.</p></div>
        <div className="records-filter-actions">
          <button type="button" className="button" onClick={startAddDoublesTeam}><Plus size={15}/> Add Team</button>
          <select value={doublesEvent} onChange={e=>setDoublesEvent(e.target.value)}>
            <option value="All">All doubles events</option>
            <option value="MD">MD — Boys/Men Doubles</option>
            <option value="WD">WD — Girls/Women Doubles</option>
            <option value="XD">XD — Mixed Doubles</option>
          </select>
          <button type="button" className="button secondary" onClick={()=>loadDoublesTeams(doublesEvent)} disabled={loadingDoubles}><RefreshCw size={15}/> {loadingDoubles?'Refreshing…':'Refresh'}</button>
        </div>
      </div>

      {showDoublesEditor && <form className="doubles-team-editor form" onSubmit={saveDoublesTeam}>
        <div className="doubles-team-editor-head">
          <div><span className="eyebrow">{doublesTeamForm.id?'EDIT PARTNERSHIP':'NEW PARTNERSHIP'}</span><h4>{doublesTeamForm.id?'Edit Doubles Team':'Add Doubles Team'}</h4><small>Choose the event and age category first, then select the partners.</small></div>
          <button type="button" className="mini" onClick={resetDoublesTeamEditor}>Close</button>
        </div>
        <div className="doubles-team-editor-grid">
          <label><span>Event</span><select value={doublesTeamForm.event_name} onChange={e=>setDoublesTeamForm({...doublesTeamForm,event_name:e.target.value,age_group:'All',player_a_id:'',player_b_id:''})}>
            <option value="MD">MD — Boys/Men Doubles</option>
            <option value="WD">WD — Girls/Women Doubles</option>
            <option value="XD">XD — Mixed Doubles</option>
          </select></label>
          <label><span>Category / Age</span><select value={doublesTeamForm.age_group} onChange={e=>setDoublesTeamForm({...doublesTeamForm,age_group:e.target.value,player_a_id:'',player_b_id:''})}>
            {doublesEditorAgeOptions.map(age=><option key={age} value={age}>{age==='All'?'All eligible ages':age}</option>)}
          </select></label>
          <Input label="Team name (optional)" value={doublesTeamForm.team_name} onChange={v=>setDoublesTeamForm({...doublesTeamForm,team_name:v})} placeholder="Defaults to Partner 1 / Partner 2"/>
          <label><span>{doublesTeamForm.event_name==='XD'?'Male / Boys partner':'Partner 1'}</span><select value={doublesTeamForm.player_a_id} onChange={e=>setDoublesTeamForm({...doublesTeamForm,player_a_id:e.target.value})}>
            <option value="">Select player</option>
            {doublesEditorPartnerA.map(p=><option key={p.id} value={p.id} disabled={String(p.id)===String(doublesTeamForm.player_b_id)}>{p.full_name} · {doublesAgeGroup(p)} · {p.club || 'Independent'}</option>)}
          </select></label>
          <label><span>{doublesTeamForm.event_name==='XD'?'Female / Girls partner':'Partner 2'}</span><select value={doublesTeamForm.player_b_id} onChange={e=>setDoublesTeamForm({...doublesTeamForm,player_b_id:e.target.value})}>
            <option value="">Select player</option>
            {doublesEditorPartnerB.map(p=><option key={p.id} value={p.id} disabled={String(p.id)===String(doublesTeamForm.player_a_id)}>{p.full_name} · {doublesAgeGroup(p)} · {p.club || 'Independent'}</option>)}
          </select></label>
        </div>
        <div className="actions">
          <button className="button"><CheckCircle2 size={15}/> {doublesTeamForm.id?'Save Team Changes':'Add Doubles Team'}</button>
          <button type="button" className="button secondary" onClick={resetDoublesTeamEditor}>Cancel</button>
        </div>
      </form>}

      <div className="records-summary">
        <div><small>Active saved teams</small><strong>{doublesTeams.length}</strong></div>
        <div><small>Doubles points</small><strong>{doublesTotals.points.toLocaleString()}</strong></div>
        <div><small>Recorded matches</small><strong>{doublesTotals.matches}</strong></div>
        <div><small>Recorded wins</small><strong>{doublesTotals.wins}</strong></div>
      </div>

      <div className="table-wrap doubles-records-table">
        <table>
          <thead><tr><th>Rank</th><th>Event</th><th>Team</th><th>Points</th><th>Add points</th><th>Played</th><th>Wins</th><th>Losses</th><th>Win %</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {doublesTeams.map(team=><tr key={team.id}>
              <td><strong className="doubles-rank">#{team.rank_position || '-'}</strong></td>
              <td><span className="badge green">{team.event_name}</span></td>
              <td><b>{team.team_name}</b><small>{team.player_a_name} + {team.player_b_name}</small></td>
              <td><b>{Number(team.total_points || 0).toLocaleString()}</b></td>
              <td><div className="points-add doubles-points-add"><input type="number" placeholder="+ points" value={doublesPointInputs[team.id] || ''} onChange={e=>setDoublesPointInputs(current=>({...current,[team.id]:e.target.value}))}/><button type="button" className="mini green" onClick={()=>addDoublesPoints(team)}>Add</button></div></td>
              <td>{team.matches_played || 0}</td>
              <td>{team.wins || 0}</td>
              <td>{team.losses || 0}</td>
              <td><b>{Number(team.win_rate || 0).toFixed(1)}%</b></td>
              <td><span className="badge green">{team.status || 'Active'}</span></td>
              <td><div className="team-row-actions"><button type="button" className="mini" onClick={()=>editDoublesTeam(team)}>Edit</button><button type="button" className="mini danger" onClick={()=>archiveDoublesTeam(team)}><Trash2 size={13}/> Delete</button></div></td>
            </tr>)}
          </tbody>
        </table>
        {!loadingDoubles && !doublesTeams.length && <div className="empty">No active doubles teams found for this filter. Use Add Team here, or create pairs from a tournament’s MD, WD or XD setup.</div>}
        {loadingDoubles && <div className="empty">Loading doubles team records…</div>}
      </div>
    </section>}
  </section>;
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
      <button className="button secondary" onClick={exportDrawPdf}><FileText size={16}/> {currentDraw.tournament_id ? 'Export Bracket PDF' : 'Export Draw PDF'}</button>
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
  const [selectedEvent, setSelectedEvent] = useState('MS');
  const [openResult, setOpenResult] = useState(null);
  const [resultDirty, setResultDirty] = useState(false);
  const [games, setGames] = useState([{a:'',b:''},{a:'',b:''},{a:'',b:''}]);
  const [busy, setBusy] = useState(false);
  const [historyDetails, setHistoryDetails] = useState({});
  const [doublesPairs, setDoublesPairs] = useState([{a:'',b:''}]);
  const [savedDoublesTeams, setSavedDoublesTeams] = useState([]);
  const [tournamentPlayers, setTournamentPlayers] = useState(players);
  const [loadingDoublesTeams, setLoadingDoublesTeams] = useState(false);
  const [bracketZoom, setBracketZoom] = useState(1);
  const [showCreate, setShowCreate] = useState(tournaments.length === 0);
  const [splitPct, setSplitPct] = useState(() => {
    const saved=Number(localStorage.getItem('lba_tournament_split') || 32);
    return Number.isFinite(saved) ? Math.max(24,Math.min(46,saved)) : 32;
  });
  const activeTournaments = useMemo(() => tournaments.filter(t=>Number(t.is_archived || 0)!==1), [tournaments]);

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

  useEffect(() => { if (!selectedId && activeTournaments.length) setSelectedId(activeTournaments[0].id); }, [activeTournaments, selectedId]);
  useEffect(() => { if (selectedId) load(selectedId); }, [selectedId]);
  useEffect(() => {
    let cancelled=false;
    api('/players?category=All&status=Active')
      .then(rows=>{ if(!cancelled) setTournamentPlayers(Array.isArray(rows) ? rows : players); })
      .catch(()=>{ if(!cancelled) setTournamentPlayers(players); });
    return ()=>{cancelled=true;};
  }, [selectedId]);
  useEffect(() => {
    if (!['MD','WD','XD'].includes(selectedEvent)) {
      setSavedDoublesTeams([]);
      setDoublesPairs([{a:'',b:''}]);
      return;
    }
    let cancelled=false;
    setDoublesPairs([{a:'',b:''}]);
    setLoadingDoublesTeams(true);
    api('/doubles/teams?event='+encodeURIComponent(selectedEvent))
      .then(rows=>{ if(!cancelled) setSavedDoublesTeams(Array.isArray(rows)?rows:[]); })
      .catch(()=>{ if(!cancelled) setSavedDoublesTeams([]); })
      .finally(()=>{ if(!cancelled) setLoadingDoublesTeams(false); });
    return ()=>{cancelled=true;};
  }, [selectedEvent, draw.category_code]);

  useEffect(() => {
    // Keep the user's selected event even when that event has no draw yet.
    // This is what allows a tournament with MS already created to add WS,
    // then MD, WD and XD one-by-one.
    if (!['MS','WS','MD','WD','XD'].includes(selectedEvent)) setSelectedEvent('MS');
  }, [selectedEvent]);
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

  const isDoublesEvent = ['MD','WD','XD'].includes(selectedEvent);
  const doublesCategoryOptions = useMemo(() => doublesAgeOptions(tournamentPlayers, selectedEvent), [tournamentPlayers, selectedEvent]);
  const setupCategoryOptions = isDoublesEvent ? doublesCategoryOptions : categoryOptions;

  const candidates = useMemo(() => {
    return tournamentPlayers.filter(p => {
      if (p.status !== 'Active') return false;
      const event = (draw.event_name || selectedEvent || 'MS').toUpperCase();
      const categoryOk = draw.category_code === 'All' || (
        ['MD','WD','XD'].includes(event)
          ? playerMatchesDoublesAge(p, draw.category_code)
          : p.category_code === draw.category_code
      );
      if (!categoryOk) return false;
      const bucket=doublesGenderBucket(p);
      if (event === 'MS' || event === 'MD') return bucket === 'M';
      if (event === 'WS' || event === 'WD') return bucket === 'W';
      if (event === 'XD') return bucket === 'M' || bucket === 'W';
      return true;
    });
  }, [tournamentPlayers, draw.category_code, draw.event_name, selectedEvent]);

  const doublesPartnerA = useMemo(() => selectedEvent==='XD' ? candidates.filter(p=>doublesGenderBucket(p)==='M') : candidates, [candidates, selectedEvent]);
  const doublesPartnerB = useMemo(() => selectedEvent==='XD' ? candidates.filter(p=>doublesGenderBucket(p)==='W') : candidates, [candidates, selectedEvent]);
  const completeDoublesPairs = useMemo(() => doublesPairs.filter(p=>p.a && p.b), [doublesPairs]);
  const visibleSavedDoublesTeams = useMemo(() => savedDoublesTeams.filter(team => {
    if (draw.category_code === 'All') return true;
    return String(team.player_a_age_group || '').toUpperCase() === String(draw.category_code).toUpperCase()
      && String(team.player_b_age_group || '').toUpperCase() === String(draw.category_code).toUpperCase();
  }), [savedDoublesTeams, draw.category_code]);

  const eventOptions = ['MS','WS','MD','WD','XD'];
  const eventDraws = useMemo(() => (detail?.draws || []).filter(d => (d.event_name || 'MS').toUpperCase() === selectedEvent), [detail, selectedEvent]);
  const eventHasDraw = eventDraws.length > 0;
  const rounds = useMemo(() => {
    const map = new Map();
    (detail?.matches || []).filter(m => (m.event_name || 'MS').toUpperCase() === selectedEvent).forEach(m => {
      const rn = Number(m.round_number || 1);
      if (!map.has(rn)) map.set(rn, { number: rn, stage: m.stage || m.draw_round || ('Round '+rn), matches: [] });
      map.get(rn).matches.push(m);
    });
    const ordered=[...map.values()].sort((a,b) => a.number-b.number);
    const firstCount=(ordered[0]?.matches || []).filter(m => !(m.stage==='Final' && m.match_no===3)).length;
    const stageForSlots = slots => ({2:'Final',4:'Semifinal',8:'Quarterfinal',16:'Round of 16',32:'Round of 32',64:'Round of 64',128:'Round of 128'}[slots] || ('Round of '+slots));
    return ordered.map((round,index) => {
      const expected=Math.max(1,Math.floor(firstCount/(2**index)));
      return {...round,stage:firstCount ? stageForSlots(expected*2) : round.stage};
    });
  }, [detail, selectedEvent]);

  const latestRound = rounds[rounds.length-1];
  const latestRoundComplete = !!latestRound && latestRound.matches.length > 0 && latestRound.matches.every(m => m.status === 'Completed');
  const selectedEventMatches = useMemo(() => (detail?.matches || []).filter(m => (m.event_name || 'MS').toUpperCase() === selectedEvent), [detail, selectedEvent]);
  const eventProgress = useMemo(() => {
    const result={};
    eventOptions.forEach(event => {
      const matches=(detail?.matches || []).filter(m => (m.event_name || 'MS').toUpperCase() === event);
      const exists=(detail?.draws || []).some(d => (d.event_name || 'MS').toUpperCase() === event);
      const completed=matches.filter(m => m.status === 'Completed').length;
      const live=matches.filter(m => m.status === 'In Progress').length;
      result[event]={exists,total:matches.length,completed,live};
    });
    return result;
  }, [detail]);
  const finalMatch = (detail?.matches || []).find(m => (m.event_name || 'MS').toUpperCase() === selectedEvent && m.stage === 'Final' && m.match_no !== 3);
  const thirdMatch = (detail?.matches || []).find(m => (m.event_name || 'MS').toUpperCase() === selectedEvent && m.stage === 'Final' && m.match_no === 3);
  const eventReadiness = useMemo(() => {
    const events = [...new Set((detail?.draws || []).map(d => (d.event_name || 'MS').toUpperCase()))];
    return events.map(event => {
      const matches = (detail?.matches || []).filter(m => (m.event_name || 'MS').toUpperCase() === event);
      const final = matches.find(m => m.stage === 'Final' && m.match_no !== 3);
      const bronze = matches.find(m => m.stage === 'Final' && m.match_no === 3);
      return {event, ready: !!final && final.status === 'Completed' && (!bronze || bronze.status === 'Completed'), final, bronze};
    });
  }, [detail]);
  const readyToFinish = eventReadiness.length > 0 && eventReadiness.every(x => x.ready);
  const podium = detail?.podium || {};
  const eventPodiums = detail?.event_podiums || {};

  const bracketModel = useMemo(() => {
    if (!eventHasDraw || !rounds.length || !rounds[0]?.matches?.length) return null;
    const firstCount = rounds[0].matches.filter(m => !(m.stage === 'Final' && m.match_no === 3)).length;
    if (!firstCount) return null;
    const totalRounds = Math.floor(Math.log2(firstCount)) + 1;
    const stageForSlots = slots => ({2:'Final',4:'Semifinal',8:'Quarterfinal',16:'Round of 16',32:'Round of 32',64:'Round of 64'}[slots] || ('Round of '+slots));
    const columns = [];

    for (let r=0; r<totalRounds; r++) {
      const expectedMatches = Math.max(1, Math.floor(firstCount / (2 ** r)));
      const actualRound = rounds.find(x => Number(x.number) === r + 1);
      const actualMatches = (actualRound?.matches || []).filter(m => !(m.stage === 'Final' && m.match_no === 3));
      const stage = stageForSlots(expectedMatches * 2);
      const matches = Array.from({length: expectedMatches}, (_,i) => {
        if (actualMatches[i]) return {...actualMatches[i], virtual:false};
        return {
          id:'standby-'+selectedEvent+'-'+r+'-'+i,
          match_no:i+1,
          match_code:'STANDBY '+(i+1),
          side_a:'Winner of previous match '+(i*2+1),
          side_b:'Winner of previous match '+(i*2+2),
          status:'Standby',
          winner:null,
          games:[],
          virtual:true
        };
      });
      columns.push({number:r+1,stage,matches});
    }
    return {firstCount,columns};
  }, [eventHasDraw, rounds, selectedEvent]);

  const bracketGeometry = useMemo(() => {
    if (!bracketModel) return null;
    const colWidth=250, gap=82, unit=122, cardHeight=92, topOffset=52;
    const width=bracketModel.columns.length*colWidth + Math.max(0,bracketModel.columns.length-1)*gap;
    const height=Math.max(150,bracketModel.firstCount*unit) + topOffset;
    const cardPosition=(roundIndex,matchIndex) => {
      const center=topOffset + (matchIndex + 0.5) * (2 ** roundIndex) * unit;
      return {x:roundIndex*(colWidth+gap), y:center-cardHeight/2, center};
    };
    const paths=[];
    bracketModel.columns.slice(0,-1).forEach((column,r) => {
      column.matches.forEach((_,i) => {
        const from=cardPosition(r,i);
        const to=cardPosition(r+1,Math.floor(i/2));
        const x1=from.x+colWidth;
        const x2=to.x;
        const mid=x1+gap/2;
        paths.push({key:r+'-'+i,d:'M '+x1+' '+from.center+' H '+mid+' V '+to.center+' H '+x2});
      });
    });
    return {colWidth,gap,unit,cardHeight,topOffset,width,height,cardPosition,paths};
  }, [bracketModel]);

  function startTournamentResize(e) {
    if (window.innerWidth <= 980) return;
    e.preventDefault();
    const container=e.currentTarget?.parentElement;
    if (!container) return;
    const rect=container.getBoundingClientRect();

    const move=ev => {
      const pct=((ev.clientX-rect.left)/rect.width)*100;
      const next=Math.max(24,Math.min(46,pct));
      setSplitPct(next);
      localStorage.setItem('lba_tournament_split',String(next));
    };

    const stop=() => {
      window.removeEventListener('pointermove',move);
      window.removeEventListener('pointerup',stop);
      document.body.style.cursor='';
      document.body.style.userSelect='';
    };

    document.body.style.cursor='col-resize';
    document.body.style.userSelect='none';
    window.addEventListener('pointermove',move);
    window.addEventListener('pointerup',stop);
  }

  function fitBracket() {
    if (!bracketGeometry) return;
    window.requestAnimationFrame(() => {
      const scroller=document.querySelector('.tournament-detail-panel .bracket-scroll');
      if (!scroller) return;
      const available=Math.max(280,scroller.clientWidth-24);
      const next=Math.max(0.5,Math.min(1.5,available/bracketGeometry.width));
      setBracketZoom(Math.round(next*100)/100);
    });
  }

  function changeBracketZoom(delta) {
    setBracketZoom(z => Math.max(0.5,Math.min(1.5,Math.round((z+delta)*10)/10)));
  }

  function updateDoublesPair(index, field, value) {
    setDoublesPairs(current => current.map((pair,i)=>i===index ? {...pair,[field]:value} : pair));
  }

  function addDoublesPair() {
    setDoublesPairs(current => {
      const last=current[current.length-1];
      if (last && !last.a && !last.b) return current;
      return [...current,{a:'',b:''}];
    });
  }

  function removeDoublesPair(index) {
    setDoublesPairs(current => {
      const next=current.filter((_,i)=>i!==index);
      return next.length ? next : [{a:'',b:''}];
    });
  }

  function clearDoublesPairs() {
    setDoublesPairs([{a:'',b:''}]);
  }

  function useSavedDoublesTeam(team) {
    const a=String(team.player_a_id || '');
    const b=String(team.player_b_id || '');
    if (!a || !b) return;
    const already=doublesPairs.some(p => [String(p.a||''),String(p.b||'')].includes(a) || [String(p.a||''),String(p.b||'')].includes(b));
    if (already) {
      setMessage('One of those partners is already assigned to another team in this draw.');
      return;
    }
    setDoublesPairs(current => {
      const emptyIndex=current.findIndex(p=>!p.a&&!p.b);
      if (emptyIndex>=0) return current.map((p,i)=>i===emptyIndex?{a,b}:p);
      return [...current,{a,b}];
    });
  }

  function togglePlayer(id) {
    setDraw(x => {
      const ids = new Set(x.player_ids);
      if (ids.has(id)) ids.delete(id); else ids.add(id);
      return {...x, player_ids:[...ids]};
    });
  }

  async function archiveTournament(tournament) {
    if (!tournament?.id) return;
    if (!window.confirm('Archive '+tournament.name+'? It will leave the active tournament list, but all draws, results and history will be preserved.')) return;
    setBusy(true);
    try {
      await api('/tournaments/'+tournament.id+'/archive',{method:'POST',body:JSON.stringify({archived:true})});
      if (selectedId===tournament.id) {
        setSelectedId(null);
        setDetail(null);
      }
      await refresh();
      setMessage(tournament.name+' archived. Its tournament history and results are preserved.');
    } catch (e) {
      setMessage(e.message || 'Could not archive tournament.');
    } finally {
      setBusy(false);
    }
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
      setShowCreate(false);
      setMessage('Tournament created. Select the event and attending players to generate its draw.');
    } catch (e) { setMessage(e.message); }
    finally { setBusy(false); }
  }

  async function generateTournamentDraw(e) {
    e.preventDefault();
    if (!selectedId) return;
    if (isDoublesEvent) {
      const incomplete=doublesPairs.some(p => (p.a && !p.b) || (!p.a && p.b));
      if (incomplete) { setMessage('Complete both partners for every doubles team, or remove the unfinished team.'); return; }
      if (completeDoublesPairs.length < 2) { setMessage('A doubles knockout draw needs at least two complete teams.'); return; }
      const ids=completeDoublesPairs.flatMap(p=>[Number(p.a),Number(p.b)]);
      if (new Set(ids).size !== ids.length) { setMessage('Each player can belong to only one team in this doubles draw.'); return; }
    } else if (draw.player_ids.length < 2) {
      setMessage('Select at least two attending players first.');
      return;
    }
    if (eventHasDraw) { setMessage(selectedEvent+' already has a draw in this tournament. Select another event to create another draw.'); return; }
    setBusy(true);
    try {
      await api('/tournaments/'+selectedId+'/draw', {
        method:'POST',
        body:JSON.stringify({
          title: draw.title,
          category_code: draw.category_code,
          draw_type: isDoublesEvent ? 'Doubles' : 'Singles',
          event_name: selectedEvent,
          seed_by_rank: draw.seed_by_rank,
          player_ids: isDoublesEvent ? completeDoublesPairs.flatMap(p=>[Number(p.a),Number(p.b)]) : draw.player_ids,
          pairs: isDoublesEvent ? completeDoublesPairs.map(p=>({player_a_id:Number(p.a),player_b_id:Number(p.b)})) : [],
          save_pairs: true
        })
      });
      await load(selectedId);
      await refresh();
      setMessage(isDoublesEvent ? selectedEvent+' teams saved and Round 1 generated. Winners will advance as complete pairs.' : 'Round 1 draw generated. Winners will advance automatically after results are entered.');
    } catch (e) { setMessage(e.message); }
    finally { setBusy(false); }
  }

  async function generateNextRound(silent=false) {
    if (!selectedId) return null;
    setBusy(true);
    try {
      const next = await api('/tournaments/'+selectedId+'/next-round', {
        method:'POST',
        body:JSON.stringify({event_name:selectedEvent,draw_type:['MD','WD','XD'].includes(selectedEvent) ? 'Doubles' : 'Singles'})
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
    const raw = games.map(g => ({a:String(g.a ?? '').trim(), b:String(g.b ?? '').trim()}));
    if (raw.some(g => (g.a === '') !== (g.b === ''))) {
      setMessage('Enter both Player A and Player B scores for each game you want to save.');
      return;
    }
    const firstEmpty = raw.findIndex(g => g.a === '' && g.b === '');
    if (firstEmpty >= 0 && raw.slice(firstEmpty + 1).some(g => g.a !== '' || g.b !== '')) {
      setMessage('Enter game scores in order: Game 1, then Game 2, then Game 3 if required.');
      return;
    }

    const used = raw
      .filter(g => g.a !== '' && g.b !== '')
      .map(g => ({side_a_score:Number(g.a),side_b_score:Number(g.b)}))
      .filter(g => Number.isFinite(g.side_a_score) && Number.isFinite(g.side_b_score));

    if (used.some(g => g.side_a_score < 0 || g.side_b_score < 0)) {
      setMessage('Scores cannot be negative. Enter a value from 0 to 30.');
      return;
    }
    if (used.some(g => g.side_a_score > 30 || g.side_b_score > 30)) {
      setMessage('A badminton game score cannot exceed 30.');
      return;
    }
    if (used.some(g => !Number.isInteger(g.side_a_score) || !Number.isInteger(g.side_b_score))) {
      setMessage('Game scores must be whole numbers.');
      return;
    }

    if (!used.length) {
      setMessage('Enter at least one completed game before saving the live result.');
      return;
    }

    setBusy(true);
    try {
      const saved = await api('/matches/'+matchId+'/result', {
        method:'POST',
        body:JSON.stringify({games:used})
      });

      setOpenResult(null);
      setResultDirty(false);
      const updated = await load(selectedId);
      await refresh();

      if (saved?.status !== 'Completed') {
        setMessage('Live score saved. This match remains in progress and can be continued after the next game.');
        return;
      }
      if (!saved.winner) throw new Error('The server marked the match complete without a winner.');

      const updatedRounds = {};
      (updated?.matches || []).filter(m => (m.event_name || 'MS').toUpperCase() === selectedEvent).forEach(m => {
        const rn=Number(m.round_number || 1);
        if (!updatedRounds[rn]) updatedRounds[rn]=[];
        updatedRounds[rn].push(m);
      });

      const roundNumbers=Object.keys(updatedRounds).map(Number).sort((a,b)=>a-b);
      const latestRn=roundNumbers[roundNumbers.length-1];
      const latestMatches=updatedRounds[latestRn] || [];
      const latestDrawStage=latestMatches[0]?.stage || '';
      const nextAlreadyExists=(updated?.matches || []).some(m => (m.event_name || 'MS').toUpperCase() === selectedEvent && Number(m.round_number || 1) > latestRn);

      if (latestMatches.length && latestMatches.every(m => m.status === 'Completed') && latestDrawStage !== 'Final' && !nextAlreadyExists) {
        await generateNextRound(true);
        setMessage('Result completed. The round is finished and the winners have advanced along their fixed bracket paths.');
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
      const pending = eventReadiness.filter(x => !x.ready).map(x => x.event).join(', ');
      setMessage('Complete the final (and any third-place match) for every event before declaring the tournament finished. Pending: '+pending+'.');
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

  return <section className="tournament-layout" style={{'--tournament-left':splitPct+'%'}}>
    <div className="panel tournament-list-panel">
      <div className="section-head tournament-manager-head">
        <div><span className="eyebrow">TOURNAMENT MANAGEMENT</span><h3>Tournaments</h3></div>
        <div className="quick-actions">
          <button type="button" className="mini" onClick={()=>setShowCreate(v=>!v)}><Plus size={14}/> {showCreate ? 'Close' : 'New Tournament'}</button>
          <CalendarDays size={22}/>
        </div>
      </div>

      {showCreate && <form className="form tournament-create-form" onSubmit={createTournament}>
        <Input label="Tournament name" value={form.name} onChange={v=>setForm({...form,name:v})}/>
        <Input label="Tournament code (optional)" value={form.tournament_code} onChange={v=>setForm({...form,tournament_code:v})}/>
        <Input label="Venue" value={form.venue} onChange={v=>setForm({...form,venue:v})}/>
        <div className="form-row">
          <Input label="Start date" type="date" value={form.start_date} onChange={v=>setForm({...form,start_date:v})}/>
          <Input label="End date" type="date" value={form.end_date} onChange={v=>setForm({...form,end_date:v})}/>
        </div>
        <button className="button" disabled={busy}><Plus size={16}/> Create Tournament</button>
      </form>}

      <div className="draw-list tournament-active-list">
        {activeTournaments.map(t=>
          <div className={selectedId===t.id ? 'tournament-list-item selected' : 'tournament-list-item'} key={t.id}>
            <button type="button" className="draw-item tournament-select-button" onClick={()=>setSelectedId(t.id)}>
              <b>{t.name}</b>
              <small>{t.tournament_code} · {t.status} · {t.completed_matches || 0}/{t.total_matches || 0} matches complete</small>
              {t.start_date && <small>{t.start_date}{t.end_date && t.end_date!==t.start_date ? ' → '+t.end_date : ''}</small>}
            </button>
            <button type="button" className="tournament-archive-button" onClick={()=>archiveTournament(t)} title="Archive tournament" aria-label={'Archive '+t.name}><Archive size={15}/></button>
          </div>
        )}
        {!activeTournaments.length&&<div className="empty">No active tournaments. Create a tournament or review archived history below.</div>}
      </div>

      <div className="tournament-history-summary">
        <div className="history-heading">
          <span className="eyebrow">ARCHIVE</span>
          <h3>Tournament History</h3>
        </div>
        {tournaments.filter(t => t.status === 'Completed' || Number(t.is_archived || 0)===1).map(t => {
          const h=historyDetails[t.id];
          const p=h?.podium || {};
          const ep=h?.event_podiums || {};
          const thirdPlayers=p.third_players || (p.third ? [p.third] : []);
          return <button className="history-card" key={'history-card-'+t.id} onClick={()=>setSelectedId(t.id)}>
            <div className="history-card-title"><b>{t.name}</b><span>{Number(t.is_archived || 0)===1 ? 'Archived · ' : ''}{t.venue || 'Venue not recorded'}</span></div>
            {Object.keys(ep).length ? <div className="history-event-summary">
              {Object.entries(ep).map(([event,podium])=><div key={event}><b>{event}</b><span>1st: {podium.first || '—'}</span><span>2nd: {podium.second || '—'}</span><span>3rd: {podium.third || '—'}</span></div>)}
            </div> : <div className="history-card-grid">
              <div><small>1st Place</small><strong>{p.first || '—'}</strong></div>
              <div><small>2nd Place</small><strong>{p.second || '—'}</strong></div>
              <div><small>3rd Place</small><strong>{thirdPlayers.length ? thirdPlayers.join(' & ') : '—'}</strong></div>
              <div><small>Date</small><strong>{t.start_date || (h?.finished_at ? formatLbaTime(h.finished_at).split(',')[0] : '—')}</strong></div>
            </div>}
            <small className="history-date">{t.start_date || (h?.finished_at ? formatLbaTime(h.finished_at).split(',')[0] : '—')}</small>
          </button>;
        })}
        {!tournaments.some(t => t.status === 'Completed' || Number(t.is_archived || 0)===1) && <div className="empty small">Completed or archived tournaments will appear here.</div>}
      </div>
    </div>

    <div className="tournament-resizer" role="separator" aria-label="Resize tournament list and draw workspace" onPointerDown={startTournamentResize}><span/></div>

    <div className="panel wide tournament-detail-panel">
      {!detail ? <div className="empty"><Trophy size={32}/><h3>Select a tournament</h3><p>Create a tournament on the left, then generate Round 1 and enter results here.</p></div> :
      <>
        <div className="tournament-overview-head">
          <div className="tournament-title-row">
            <div className="tournament-title-copy">
              <span className="eyebrow">{detail.tournament_code}</span>
              <h3>{detail.name}</h3>
            </div>
            <div className="quick-actions tournament-report-actions">
              <button className="button" onClick={()=>exportFile('/tournaments/'+detail.id+'/executive-draws.pdf',detail.tournament_code+'_Executive_Draw_Pack.pdf')}><FileText size={16}/> Executive Draw Pack</button>
              <button className="button secondary" onClick={()=>exportFile('/tournaments/'+detail.id+'/export.xlsx',detail.tournament_code+'_tournament.xlsx')}><Download size={16}/> Results Excel</button>
              <button className="button secondary" onClick={()=>exportFile('/tournaments/'+detail.id+'/scoresheets.pdf',detail.tournament_code+'_scoresheets.pdf')}><ClipboardList size={16}/> Match Scoresheets</button>
            </div>
          </div>
          <div className="tournament-meta-strip">
            <div><small>Venue</small><b>{detail.venue || 'Not set'}</b></div>
            <div><small>Tournament date</small><b>{detail.start_date || 'Not set'}</b></div>
            <div><small>Status</small><b>{detail.status}</b></div>
            <div className="tournament-time-meta"><small>System time · Lesotho / SAST</small><b>{formatLbaTime(detail.server_time)}</b><span>UTC+02:00</span></div>
          </div>
        </div>

        {(Object.keys(eventPodiums).length || podium.first || podium.second || podium.third) > 0 && <div className="podium-card">
          <div className="podium-title"><Trophy size={20}/> Event Podiums</div>
          {Object.keys(eventPodiums).length > 0 ? <div className="event-podium-list">
            {Object.entries(eventPodiums).map(([event,p])=><div className="event-podium-row" key={event}>
              <strong>{event}</strong><span>1st: <b>{p.first || '—'}</b></span><span>2nd: <b>{p.second || '—'}</b></span><span>3rd: <b>{p.third || '—'}</b></span>
            </div>)}
          </div> : <div className="podium-grid">
            <div><span>1st</span><b>{podium.first || '—'}</b></div>
            <div><span>2nd</span><b>{podium.second || '—'}</b></div>
            <div><span>3rd</span><b>{podium.third || '—'}</b></div>
          </div>}
          {detail.finished_at && <small>Declared finished by {detail.finished_by || 'admin'} on {formatLbaTime(detail.finished_at)}</small>}
        </div>}

        <div className="stats tournament-event-stats">
          <Stat label={selectedEvent+" Rounds"} value={rounds.length}/>
          <Stat label={selectedEvent+" Matches"} value={selectedEventMatches.length}/>
          <Stat label="Completed" value={selectedEventMatches.filter(m=>m.status==='Completed').length}/>
          <Stat label="Pending / Live" value={selectedEventMatches.filter(m=>m.status!=='Completed').length}/>
        </div>

        <div className="tournament-event-bar">
          <div>
            <span className="eyebrow">EVENT DRAWS</span>
            <b>One tournament · multiple independent draws</b>
            <small>Create and run MS, WS, MD, WD and XD under the same tournament record.</small>
          </div>
          <div className="event-tabs">
            {eventOptions.map(event => {
              const info=eventProgress[event] || {exists:false,total:0,completed:0,live:0};
              const status=!info.exists ? 'Add draw' : (info.total && info.completed===info.total ? 'Complete' : (info.live ? info.completed+'/'+info.total+' · LIVE' : info.completed+'/'+info.total+' done'));
              return <button key={event} type="button" className={selectedEvent===event ? 'event-tab active' : 'event-tab'} onClick={()=>{setSelectedEvent(event);setDoublesPairs([{a:'',b:''}]);setDraw(d=>({...d,event_name:event,draw_type:['MD','WD','XD'].includes(event)?'Doubles':'Singles',category_code:'All',player_ids:[],title:detail.name+' — '+event}));}}>
                <b>{event}</b><span>{status}</span>
              </button>;
            })}
          </div>
        </div>

        {!eventHasDraw ? <div className="panel">
          <h3>Set up {selectedEvent} Draw</h3>
          <p className="helper">This tournament can contain separate draws for MS, WS, MD, WD and XD. Select an event below and generate its Round 1 independently.</p>
          <form className="form" onSubmit={generateTournamentDraw}>
            <div className="tournament-setup-grid">
              <Input label="Draw title" value={draw.title} onChange={v=>setDraw({...draw,title:v})}/>
              <label><span>Event</span><select value={selectedEvent} onChange={e=>{const event=e.target.value;setSelectedEvent(event);setDoublesPairs([{a:'',b:''}]);setDraw({...draw,event_name:event,draw_type:['MD','WD','XD'].includes(event)?'Doubles':'Singles',category_code:'All',player_ids:[],title:detail.name+' — '+event});}}>
                <option value="MS">MS — Boys Singles</option>
                <option value="WS">WS — Girls Singles</option>
                <option value="MD">MD — Boys Doubles</option>
                <option value="WD">WD — Girls Doubles</option>
                <option value="XD">XD — Mixed Doubles</option>
              </select></label>
              <label><span>{isDoublesEvent ? 'Doubles Category / Age' : 'Category / Age'}</span><select value={draw.category_code} onChange={e=>{setDoublesPairs([{a:'',b:''}]);setDraw({...draw,category_code:e.target.value,player_ids:[]});}}>{setupCategoryOptions.map(c=><option key={c} value={c}>{c==='All' ? (isDoublesEvent ? 'All eligible ages' : 'All') : c}</option>)}</select></label>
              <label className="check setup-seed"><input type="checkbox" checked={draw.seed_by_rank} onChange={e=>setDraw({...draw,seed_by_rank:e.target.checked})}/> Seed the first round by ranking</label>
            </div>
            {!isDoublesEvent ? <>
              <div className="participant-head"><b>Attending players</b><span>{draw.player_ids.length} selected</span></div>
              <div className="participant-actions"><button type="button" className="mini" onClick={()=>setDraw(x=>({...x,player_ids:candidates.map(p=>p.id)}))}>Select all shown</button><button type="button" className="mini" onClick={()=>setDraw(x=>({...x,player_ids:[]}))}>Clear</button></div>
              <div className="participant-list">{candidates.map(p=><label className="participant" key={p.id}><input type="checkbox" checked={draw.player_ids.includes(p.id)} onChange={()=>togglePlayer(p.id)}/><span><b>{p.full_name}</b><small>{p.category_code} · {p.gender} · {p.event_type || '—'} · Rank #{p.rank_position || '-'} · {p.total_points} pts</small></span></label>)}{!candidates.length&&<div className="empty small">No active players found in this category.</div>}</div>
            </> : <div className="doubles-builder">
              <div className="participant-head">
                <div><b>{selectedEvent} Teams</b><small>Pair partners explicitly before generating the draw.</small></div>
                <span>{completeDoublesPairs.length} teams ready · {completeDoublesPairs.length*2} players</span>
              </div>
              <div className="doubles-rule">
                <Users size={17}/>
                <span>{selectedEvent==='XD' ? 'Mixed Doubles requires one male/boys partner and one female/girls partner.' : selectedEvent==='MD' ? 'Men’s Doubles requires two male/boys partners per team.' : 'Women’s Doubles requires two female/girls partners per team.'} Teams are automatically saved to Doubles Records for future tournaments.</span>
              </div>

              <div className="doubles-pair-list">
                {doublesPairs.map((pair,index)=>{
                  const usedElsewhere=new Set(doublesPairs.flatMap((p,i)=>i===index?[]:[String(p.a||''),String(p.b||'')]).filter(Boolean));
                  return <div className="doubles-pair-card" key={'pair-'+index}>
                    <div className="doubles-pair-head"><strong>Team {index+1}</strong><button type="button" className="mini danger" onClick={()=>removeDoublesPair(index)} disabled={doublesPairs.length===1}>Remove</button></div>
                    <div className="doubles-partner-grid">
                      <label><span>{selectedEvent==='XD'?'Male / Boys partner':'Partner 1'}</span><select value={pair.a} onChange={e=>updateDoublesPair(index,'a',e.target.value)}>
                        <option value="">Select player</option>
                        {doublesPartnerA.map(p=><option key={p.id} value={p.id} disabled={usedElsewhere.has(String(p.id)) || String(pair.b)===String(p.id)}>{p.full_name} · {p.club || 'Independent'}</option>)}
                      </select></label>
                      <div className="pair-link"><span>+</span></div>
                      <label><span>{selectedEvent==='XD'?'Female / Girls partner':'Partner 2'}</span><select value={pair.b} onChange={e=>updateDoublesPair(index,'b',e.target.value)}>
                        <option value="">Select player</option>
                        {doublesPartnerB.map(p=><option key={p.id} value={p.id} disabled={usedElsewhere.has(String(p.id)) || String(pair.a)===String(p.id)}>{p.full_name} · {p.club || 'Independent'}</option>)}
                      </select></label>
                    </div>
                    {pair.a && pair.b && <div className="paired-team-preview"><CheckCircle2 size={14}/><b>{tournamentPlayers.find(p=>String(p.id)===String(pair.a))?.full_name}</b><span>&</span><b>{tournamentPlayers.find(p=>String(p.id)===String(pair.b))?.full_name}</b></div>}
                  </div>;
                })}
              </div>
              <div className="participant-actions">
                <button type="button" className="mini green" onClick={addDoublesPair}><Plus size={14}/> Add Team</button>
                <button type="button" className="mini" onClick={clearDoublesPairs}>Clear Teams</button>
              </div>

              <div className="doubles-records">
                <div className="doubles-records-head"><div><span className="eyebrow">DOUBLES RECORDS</span><b>Saved {selectedEvent} partnerships</b></div><small>{loadingDoublesTeams?'Loading…':visibleSavedDoublesTeams.length+' shown'}</small></div>
                <div className="doubles-record-grid">
                  {visibleSavedDoublesTeams.map(team=><div className="doubles-record-card" key={team.id}>
                    <div><b>{team.team_name}</b><small>{team.matches_played || 0} matches · {team.wins || 0}W–{team.losses || 0}L · {Number(team.win_rate || 0)}%</small></div>
                    <button type="button" className="mini" onClick={()=>useSavedDoublesTeam(team)}>Use Team</button>
                  </div>)}
                  {!loadingDoublesTeams && !visibleSavedDoublesTeams.length && <div className="empty small">No saved {selectedEvent} partnerships found for {draw.category_code==='All'?'the selected event':draw.category_code}. Teams created here will be saved automatically.</div>}
                </div>
              </div>
            </div>}
            <button className="button" disabled={busy || (isDoublesEvent && completeDoublesPairs.length<2)}><Shuffle size={16}/> Generate {isDoublesEvent ? selectedEvent+' Round 1 — '+completeDoublesPairs.length+' Teams' : 'Round 1 Draw'}</button>
          </form>
        </div> : <div className="panel round-workspace">
          <div className="round-action-bar">
            <div>
              <b>{selectedEvent} knockout progression</b>
              <small>{latestRound ? 'Latest generated round: '+latestRound.stage+'. ' : ''}Record results live; completed winners follow the fixed bracket path.</small>
            </div>
            <div className="quick-actions">
              <button className="button secondary" onClick={()=>exportFile('/tournaments/'+detail.id+'/bracket.pdf?event='+encodeURIComponent(selectedEvent),detail.tournament_code+'_'+selectedEvent+'_'+(latestRound?.stage || 'draw').replaceAll(' ','_')+'_draw.pdf')}><FileText size={16}/> Export This Event</button>
              {latestRoundComplete && latestRound?.stage !== 'Final' && <button className="mini advance-recovery" disabled={busy} onClick={()=>generateNextRound(false)} title="Use only if automatic advancement did not create the next round"><RefreshCw size={14}/> Advance Round</button>}
              {readyToFinish && detail.status !== 'Completed' && <button className="button" disabled={busy} onClick={finishTournament}><Trophy size={16}/> Declare Tournament Finished</button>}
            </div>
          </div>

          <div className="live-bracket">
            <div className="live-bracket-head">
              <div><span className="eyebrow">LIVE DRAW PATH</span><h3>{selectedEvent} Knockout Bracket</h3><small>Filled through {latestRound?.stage || 'the current draw'}; future matches remain on standby.</small></div>
              <div className="bracket-view-tools">
                <button type="button" className="mini" onClick={()=>changeBracketZoom(-0.1)} disabled={bracketZoom<=0.5}>−</button>
                <b>{Math.round(bracketZoom*100)}%</b>
                <button type="button" className="mini" onClick={()=>changeBracketZoom(0.1)} disabled={bracketZoom>=1.5}>+</button>
                <button type="button" className="mini" onClick={fitBracket}>Fit</button>
                <button type="button" className="mini" onClick={()=>setBracketZoom(1)}>100%</button>
              </div>
            </div>
            {bracketModel && bracketGeometry && <div className="bracket-scroll">
              <div className="bracket-zoom-shell" style={{width:bracketGeometry.width*bracketZoom,height:bracketGeometry.height*bracketZoom}}>
              <div className="bracket-canvas" style={{width:bracketGeometry.width,height:bracketGeometry.height,transform:'scale('+bracketZoom+')',transformOrigin:'top left'}}>
                <svg className="bracket-connectors" width={bracketGeometry.width} height={bracketGeometry.height} viewBox={'0 0 '+bracketGeometry.width+' '+bracketGeometry.height} aria-hidden="true">
                  {bracketGeometry.paths.map(p=><path key={p.key} d={p.d}/>)}
                </svg>
                {bracketModel.columns.map((column,r) => {
                  const x=r*(bracketGeometry.colWidth+bracketGeometry.gap);
                  const completed=column.matches.filter(m=>m.status==='Completed').length;
                  return <React.Fragment key={'bracket-column-'+r}>
                    <div className="bracket-stage-title" style={{left:x,width:bracketGeometry.colWidth}}>
                      <b>{column.stage}</b><span>{completed}/{column.matches.length}</span>
                    </div>
                    {column.matches.map((m,i) => {
                      const pos=bracketGeometry.cardPosition(r,i);
                      const scores=m.games?.length ? m.games.map(g=>g.side_a_score+'-'+g.side_b_score).join(' · ') : '';
                      const state=m.virtual ? 'standby' : (m.status==='Completed' ? 'complete' : (m.status==='In Progress' ? 'progress' : 'pending'));
                      return <div className={'bracket-match '+state} style={{left:pos.x,top:pos.y,width:bracketGeometry.colWidth}} key={'path-'+m.id}>
                        <small>{m.match_code || ('M'+m.match_no)} · {m.virtual ? 'STANDBY' : (m.status==='Completed' ? 'RESULT' : (m.status==='In Progress' ? 'LIVE' : 'READY'))}</small>
                        <div className={m.winner===m.side_a?'winner':''}><span>{m.side_a}</span>{m.winner===m.side_a&&<b>✓</b>}</div>
                        <div className={m.winner===m.side_b?'winner':''}><span>{m.side_b}</span>{m.winner===m.side_b&&<b>✓</b>}</div>
                        {scores&&<em>{scores}</em>}
                      </div>;
                    })}
                  </React.Fragment>;
                })}
              </div>
              </div>
            </div>}
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
                  {m.status === 'Completed' ? <div className="result-complete-row"><div className="helper"><CheckCircle2 size={15}/> {m.winner}{scoreText}{recordedText}</div><button className="mini" onClick={()=>startResult(m)}>Edit Result</button></div> :
                    <div className="result-live-row">
                      {m.status === 'In Progress' && <span className="live-score-badge">LIVE · {m.games?.map(g=>g.side_a_score+'-'+g.side_b_score).join(' · ') || 'score saved'}</span>}
                      <button className="mini" onClick={()=>startResult(m)}>{m.status === 'In Progress' ? 'Continue Result' : 'Record Result'}</button>
                    </div>}
                  {openResult === m.id && <div className="form result-entry">
                    <b>Enter game scores — best of 3</b>
                    {games.map((g,i)=><div className="result-game-row" key={i}><Input label={'Game '+(i+1)+' · Player A'} type="number" min="0" max="30" step="1" inputMode="numeric" value={g.a} onChange={v=>{if(v!==''&&(Number(v)<0||Number(v)>30))return;setResultDirty(true);setGames(gs=>gs.map((x,j)=>j===i?{...x,a:v}:x))}}/><Input label={'Game '+(i+1)+' · Player B'} type="number" min="0" max="30" step="1" inputMode="numeric" value={g.b} onChange={v=>{if(v!==''&&(Number(v)<0||Number(v)>30))return;setResultDirty(true);setGames(gs=>gs.map((x,j)=>j===i?{...x,b:v}:x))}}/></div>)}
                    <small className="helper">Save after each completed game if you are recording the match live. Badminton scoring: 21-point games, win by 2 after 20-all, with 30 as the maximum.</small>
                    <button type="button" className="button result-save-button" onClick={()=>saveResult(m.id)} disabled={busy}>
                      {busy ? 'Saving…' : 'Save Live Result'}
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
function Input({ label, value, onChange=()=>{}, type = 'text', min, max, step, inputMode, readOnly=false, placeholder='' }) { return <label><span>{label}</span><input type={type} min={min} max={max} step={step} inputMode={inputMode} value={value ?? ''} readOnly={readOnly} placeholder={placeholder} className={readOnly?'readonly-input':''} onChange={e => onChange(e.target.value)} /></label>; }

createRoot(document.getElementById('root')).render(<App />);
