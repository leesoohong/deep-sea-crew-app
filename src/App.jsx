import React, { useState, useEffect } from 'react';
import { onAuthStateChanged, signInAnonymously } from 'firebase/auth';
import { ref, get, set, onValue } from 'firebase/database';
import { auth, db } from './firebase';
import { Game, TASKS_BY_ID, LAST_TRICK_INDEX } from './game/engine';
import { CAMPAIGN_MISSIONS } from './game/campaign';

const SUIT_INFO = {
  PINK: { label: '분홍', color: '#FF6FA5' },
  BLUE: { label: '파랑', color: '#4C8DFF' },
  GREEN: { label: '초록', color: '#3FCB82' },
  YELLOW: { label: '노랑', color: '#F2C94C' },
  SUBMARINE: { label: '로켓', color: '#C8CDD4' },
};

// Firebase는 undefined를 저장 못 하므로 재귀적으로 제거
function stripUndefined(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripUndefined);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = stripUndefined(v);
  }
  return out;
}

async function readRoom(code) {
  const snap = await get(ref(db, `rooms/${code}`));
  return snap.exists() ? snap.val() : null;
}
async function writeRoom(code, roomObj) {
  await set(ref(db, `rooms/${code}`), stripUndefined(roomObj));
}

// 크루 이름을 Firebase 키로 안전하게 변환 (.#$[]/ 및 공백 제거)
function crewKey(name) {
  return 'crew_' + name.trim().toLowerCase().replace(/[.#$/\[\]\s]/g, '_').slice(0, 40);
}
async function readCrewSave(name) {
  const snap = await get(ref(db, `crews/${crewKey(name)}`));
  return snap.exists() ? snap.val() : null;
}
async function writeCrewSave(name, data) {
  await set(ref(db, `crews/${crewKey(name)}`), stripUndefined(data));
}

// room 저장 형태: { code, hostId, numPlayers, started, members: {playerId: {name, seat}}, game: <Game.toJSON()> }

function loadGame(room) {
  if (!room || !room.game) return null;
  try { return Game.fromJSON(room.game); } catch (e) { return null; }
}

function CardChip({ card, disabled, onClick, size = 'md', dim }) {
  const info = SUIT_INFO[card.suit];
  const isRocket = card.suit === 'SUBMARINE';
  const dims = size === 'lg' ? { w: 50, h: 70, fs: 20 } : { w: 40, h: 56, fs: 16 };
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        width: dims.w, height: dims.h, borderRadius: 9,
        border: isRocket ? '2px solid #000000' : `2px solid ${info.color}`,
        background: isRocket ? '#000000' : `${info.color}1A`,
        color: isRocket ? '#FFFFFF' : info.color, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        opacity: dim ? 0.4 : 1, flexShrink: 0,
        cursor: (disabled || !onClick) ? 'default' : 'pointer', fontFamily: "'Space Grotesk', sans-serif",
      }}>
      <span style={{ fontSize: dims.fs, fontWeight: 700, lineHeight: 1 }}>{card.value}</span>
      <span style={{ fontSize: 8, marginTop: 2 }}>{isRocket ? '🚀' : info.label}</span>
    </button>
  );
}

// 물속 뽀글뽀글 앰비언트 BGM (밝고 귀여운 느낌, Web Audio API로 합성)
function useOceanAmbience() {
  const ctxRef = React.useRef(null);
  const timerRef = React.useRef(null);
  const nodesRef = React.useRef([]);
  const [playing, setPlaying] = React.useState(false);

  const start = () => {
    if (ctxRef.current) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    ctxRef.current = ctx;

    const master = ctx.createGain();
    master.gain.value = 0;
    master.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 2);
    master.connect(ctx.destination);

    // 부드러운 배경 패드 (밝은 화음: C, E, G, C — 은은하게)
    const padGain = ctx.createGain();
    padGain.gain.value = 0.06;
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 1200;
    padFilter.connect(padGain);
    padGain.connect(master);
    [261.6, 329.6, 392.0, 523.3].forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.5 / (i + 2);
      // 아주 느린 흔들림
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.06 + i * 0.015;
      const lfoG = ctx.createGain();
      lfoG.gain.value = 0.15;
      lfo.connect(lfoG); lfoG.connect(g.gain);
      osc.connect(g); g.connect(padFilter);
      osc.start(); lfo.start();
      nodesRef.current.push(osc, lfo);
    });

    // 뽀글 물방울 하나 재생
    const bubble = () => {
      if (!ctxRef.current) return;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      // 낮은 음에서 높은 음으로 빠르게 올라가는 "뽀글" 특유의 삑 소리
      const startF = 400 + Math.random() * 500;
      const endF = startF + 300 + Math.random() * 700;
      osc.frequency.setValueAtTime(startF, t);
      osc.frequency.exponentialRampToValueAtTime(endF, t + 0.08);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.12 + Math.random() * 0.06, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.12 + Math.random() * 0.08);
      osc.connect(g); g.connect(master);
      osc.start(t);
      osc.stop(t + 0.25);
    };

    // 랜덤 간격으로 물방울 (가끔 여러 개 연달아 = 뽀글뽀글)
    const scheduleBubbles = () => {
      const cluster = Math.random() < 0.3 ? 2 + Math.floor(Math.random() * 3) : 1;
      for (let i = 0; i < cluster; i++) setTimeout(bubble, i * (80 + Math.random() * 120));
      timerRef.current = setTimeout(scheduleBubbles, 500 + Math.random() * 1800);
    };
    scheduleBubbles();

    setPlaying(true);
  };

  const stop = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    const ctx = ctxRef.current;
    if (!ctx) return;
    nodesRef.current.forEach((n) => { try { n.stop(); } catch (e) {} });
    nodesRef.current = [];
    ctx.close();
    ctxRef.current = null;
    setPlaying(false);
  };

  const toggle = () => { if (playing) stop(); else start(); };
  React.useEffect(() => () => stop(), []);
  return { playing, toggle };
}

// 미션 텍스트를 자리 옆에 붙일 짧은 형태로 요약
function shortTaskLabel(task) {
  // task.text가 짧으면 그대로, 길면 앞부분 + 말줄임 (id도 함께)
  const text = (task.text || '').replace(/^owner(가|는)\s*/, '').trim();
  if (text.length <= 16) return text;
  return `${task.id}`;
}

// 잠수부 (구리 헬멧 클래식 다이버, 직접 그린 SVG)
function DiverSilhouette({ style }) {
  return (
    <svg viewBox="0 0 120 150" width="80" height="100" style={style} aria-hidden>
      <ellipse cx="34" cy="16" rx="4" ry="5" fill="#bfe6f0" opacity="0.6" />
      <ellipse cx="46" cy="6" rx="3" ry="4" fill="#bfe6f0" opacity="0.5" />
      <ellipse cx="26" cy="28" rx="5" ry="6" fill="#bfe6f0" opacity="0.5" />
      <path d="M78 34 Q100 54 90 84" fill="none" stroke="#1a3a48" strokeWidth="4" strokeLinecap="round" />
      <rect x="28" y="74" width="64" height="58" rx="20" fill="#2f5f3a" stroke="#1f4227" strokeWidth="3" />
      <rect x="16" y="82" width="18" height="34" rx="9" fill="#2f5f3a" stroke="#1f4227" strokeWidth="3" />
      <rect x="86" y="82" width="18" height="34" rx="9" fill="#2f5f3a" stroke="#1f4227" strokeWidth="3" />
      <rect x="46" y="96" width="28" height="20" rx="5" fill="#9aa0a6" stroke="#5f6469" strokeWidth="2" />
      <circle cx="60" cy="36" r="30" fill="#c8802e" stroke="#7a4a14" strokeWidth="4" />
      <circle cx="60" cy="18" r="7" fill="#c8802e" stroke="#7a4a14" strokeWidth="3" />
      <circle cx="60" cy="36" r="18" fill="#153f52" stroke="#7a4a14" strokeWidth="4" />
      <ellipse cx="51" cy="28" rx="7" ry="5" fill="#bfe6f0" opacity="0.7" />
      <rect x="18" y="26" width="12" height="14" rx="4" fill="#b0742a" stroke="#7a4a14" strokeWidth="2" />
      <rect x="90" y="26" width="12" height="14" rx="4" fill="#b0742a" stroke="#7a4a14" strokeWidth="2" />
    </svg>
  );
}

// 빈티지 잠수함 (제목 양옆 장식용)
function SubmarineIcon({ style, flip }) {
  return (
    <svg viewBox="0 0 150 120" width="66" height="53" style={{ ...(flip ? { transform: 'scaleX(-1)' } : {}), ...style }} aria-hidden>
      <ellipse cx="45" cy="42" rx="5" ry="6" fill="#bfe6f0" opacity="0.6" />
      <ellipse cx="57" cy="28" rx="3" ry="4" fill="#bfe6f0" opacity="0.5" />
      <g transform="translate(75,68)">
        <ellipse cx="0" cy="4" rx="62" ry="32" fill="#c8802e" stroke="#7a4a14" strokeWidth="3.5" />
        <path d="M60 4 Q82 -14 82 4 Q82 22 60 4 Z" fill="#b0742a" stroke="#7a4a14" strokeWidth="3.5" />
        <rect x="-16" y="-34" width="32" height="20" rx="8" fill="#b0742a" stroke="#7a4a14" strokeWidth="3.5" />
        <rect x="-3" y="-54" width="6" height="24" rx="3" fill="#8a5518" stroke="#7a4a14" strokeWidth="2" />
        <circle cx="0" cy="-58" r="5" fill="#f2c94c" stroke="#7a4a14" strokeWidth="2" />
        <circle cx="-26" cy="2" r="13" fill="#153f52" stroke="#7a4a14" strokeWidth="3.5" />
        <ellipse cx="-31" cy="-3" rx="4" ry="3" fill="#bfe6f0" opacity="0.7" />
        <circle cx="6" cy="4" r="13" fill="#153f52" stroke="#7a4a14" strokeWidth="3.5" />
        <ellipse cx="1" cy="-1" rx="4" ry="3" fill="#bfe6f0" opacity="0.7" />
        <circle cx="34" cy="6" r="9" fill="#153f52" stroke="#7a4a14" strokeWidth="3" />
        <circle cx="-44" cy="24" r="5" fill="#8a5518" />
        <circle cx="-22" cy="31" r="5" fill="#8a5518" />
        <circle cx="2" cy="33" r="5" fill="#8a5518" />
        <circle cx="26" cy="31" r="5" fill="#8a5518" />
      </g>
    </svg>
  );
}

// 내 좌석(mySeat)을 아래(bottom)에 고정하고, 나머지를 시계방향으로 배치.
// 반환: { [seat]: 'bottom'|'left'|'top'|'right'|'topleft'|'topright' }
function seatPositions(numPlayers, mySeat) {
  // 내 기준 상대 순번(시계방향): 0=나, 1,2,3,4...
  const rel = (s) => (s - mySeat + numPlayers) % numPlayers;
  const map = {};
  const layouts = {
    3: ['bottom', 'left', 'right'],
    4: ['bottom', 'left', 'top', 'right'],
    5: ['bottom', 'left', 'topleft', 'topright', 'right'],
  };
  const layout = layouts[numPlayers] || layouts[4];
  for (let s = 0; s < numPlayers; s++) map[s] = layout[rel(s)];
  return map;
}

// 테이블 위 특정 위치에 놓일 좌석 슬롯
function TableSeat({ seat, pos, seatName, playedCard, isToAct, isWinner, isCaptain, isMe, tasks }) {
  const posStyle = {
    bottom: { bottom: 6, left: '50%', transform: 'translateX(-50%)', flexDirection: 'column' },
    top: { top: 6, left: '50%', transform: 'translateX(-50%)', flexDirection: 'column-reverse' },
    left: { left: 6, top: '50%', transform: 'translateY(-50%)', flexDirection: 'column' },
    right: { right: 6, top: '50%', transform: 'translateY(-50%)', flexDirection: 'column' },
    topleft: { top: 6, left: 6, flexDirection: 'column-reverse' },
    topright: { top: 6, right: 6, flexDirection: 'column-reverse' },
  }[pos] || { bottom: 6, left: '50%', transform: 'translateX(-50%)' };

  return (
    <div style={{ position: 'absolute', display: 'flex', alignItems: 'center', gap: 4, maxWidth: 150, ...posStyle }}>
      <div style={{
        fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 8, whiteSpace: 'nowrap',
        background: isToAct ? 'rgba(47,230,199,0.2)' : 'rgba(0,0,0,0.35)',
        color: isToAct ? '#2FE6C7' : '#EAF6F6',
        border: isToAct ? '1px solid #2FE6C7' : '1px solid rgba(255,255,255,0.1)',
      }}>
        {isCaptain ? '⚓ ' : ''}{seatName}{isMe ? ' (나)' : ''}
      </div>
      {/* 이 사람의 미션 뱃지 */}
      {tasks && tasks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>
          {tasks.map((t) => (
            <div key={t.id} title={t.text} style={{
              fontSize: 9.5, padding: '1px 6px', borderRadius: 6, maxWidth: 140, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              background: t.status === 'success' ? 'rgba(47,230,199,0.2)' : t.status === 'fail' ? 'rgba(255,111,165,0.2)' : 'rgba(240,184,74,0.18)',
              color: t.status === 'success' ? '#2FE6C7' : t.status === 'fail' ? '#FF6FA5' : '#F0B84B',
              border: `1px solid ${t.status === 'success' ? 'rgba(47,230,199,0.4)' : t.status === 'fail' ? 'rgba(255,111,165,0.4)' : 'rgba(240,184,74,0.35)'}`,
            }}>
              {t.status === 'success' ? '✅ ' : t.status === 'fail' ? '❌ ' : ''}{shortTaskLabel(t)}
            </div>
          ))}
        </div>
      )}
      <div style={{ height: 72, display: 'flex', alignItems: 'center' }}>
        {playedCard ? (
          <div style={{ position: 'relative' }}>
            <CardChip card={playedCard} disabled />
            {isWinner && <div style={{ position: 'absolute', top: -8, right: -8, fontSize: 14 }}>👑</div>}
          </div>
        ) : (
          <div style={{ width: 40, height: 56, borderRadius: 9, border: '1px dashed rgba(255,255,255,0.12)' }} />
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [myId, setMyId] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [screen, setScreen] = useState('join'); // join | lobby | game
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [name, setName] = useState('');
  const [numPlayersInput, setNumPlayersInput] = useState(3);
  const [crewName, setCrewName] = useState('');
  const [crewPassword, setCrewPassword] = useState('');
  const [joinMode, setJoinMode] = useState('new'); // 'new' | 'continue' | 'join'
  const [room, setRoom] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [predictInput, setPredictInput] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [chatOpen, setChatOpen] = useState(false);
  const ambience = useOceanAmbience();

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) { setMyId(user.uid); setAuthReady(true); }
      else signInAnonymously(auth).catch(() => setAuthReady(true));
    });
    return () => unsub();
  }, []);

  // 새로고침 후 이전에 있던 방으로 자동 복귀 (게임 진행 중이던 경우만)
  useEffect(() => {
    if (!authReady || !myId) return;
    let saved;
    try { saved = JSON.parse(localStorage.getItem('crew_session') || 'null'); } catch (e) { saved = null; }
    if (!saved || !saved.roomCode) return;
    (async () => {
      const r = await readRoom(saved.roomCode);
      // 내가 멤버이고 && 게임이 실제로 시작된 방일 때만 자동 복귀
      if (r && r.started && r.members && r.members[myId]) {
        setRoomCode(saved.roomCode);
        setRoom(r);
        setName(r.members[myId].name || '');
        setScreen('game');
      } else {
        localStorage.removeItem('crew_session');
      }
    })();
  }, [authReady, myId]);

  // 방에 들어가 게임이 시작됐으면 세션 저장 (새로고침 대비)
  useEffect(() => {
    if (roomCode && room && room.started) {
      try { localStorage.setItem('crew_session', JSON.stringify({ roomCode })); } catch (e) {}
    }
    // 시작 화면으로 돌아오면 남은 세션 제거 (새 시작을 막지 않도록)
    if (screen === 'join') {
      try { localStorage.removeItem('crew_session'); } catch (e) {}
    }
  }, [roomCode, room, screen]);

  useEffect(() => {
    if (screen === 'join' || !roomCode) return;
    const roomRef = ref(db, `rooms/${roomCode}`);
    const unsub = onValue(roomRef, (snap) => { if (snap.exists()) setRoom(snap.val()); });
    return () => unsub();
  }, [screen, roomCode]);

  useEffect(() => {
    if (!room) return;
    if (room.started && screen === 'lobby') setScreen('game');
    if (!room.started && screen === 'game') setScreen('lobby');
  }, [room, screen]);

  // ---------- 로비 액션 ----------
  const handleCreate = async () => {
    if (!name.trim()) { setError('이름을 입력해주세요'); return; }
    if (!crewName.trim()) { setError('크루 이름을 입력해주세요'); return; }
    if (!/^\d{4}$/.test(crewPassword)) { setError('암호는 숫자 4자리로 입력해주세요'); return; }
    setError('');
    setBusy(true);
    try {
      // 같은 크루 이름이 이미 있으면 막기
      let existing = null;
      try { existing = await readCrewSave(crewName); } catch (e) { existing = null; }
      if (existing) { setBusy(false); setError('이미 있는 크루 이름이에요. 이어하기를 쓰거나 다른 이름을 정해주세요'); return; }
      const code = Math.floor(1000 + Math.random() * 9000).toString();
      const room0 = {
        code, hostId: myId, numPlayers: numPlayersInput, started: false,
        crewName: crewName.trim(), password: crewPassword,
        members: { [myId]: { name: name.trim(), seat: 0 } },
        game: null,
      };
      await writeRoom(code, room0);
      setRoomCode(code); setRoom(room0); setScreen('lobby');
    } catch (e) {
      setError('방 생성에 실패했어요: ' + (e.message || '알 수 없는 오류'));
    }
    setBusy(false);
  };

  // 이어하기: 크루 이름 + 암호로 저장된 진행 상황을 새 방으로 복원
  const handleContinue = async () => {
    if (!name.trim()) { setError('이름을 입력해주세요'); return; }
    if (!crewName.trim() || !/^\d{4}$/.test(crewPassword)) { setError('크루 이름과 4자리 암호를 입력해주세요'); return; }
    setError('');
    setBusy(true);
    try {
      const save = await readCrewSave(crewName);
      if (!save) { setBusy(false); setError('그 이름의 크루를 찾을 수 없어요'); return; }
      if (save.password !== crewPassword) { setBusy(false); setError('암호가 틀렸어요'); return; }
      const code = Math.floor(1000 + Math.random() * 9000).toString();
      const room0 = {
        code, hostId: myId, numPlayers: save.numPlayers, started: false,
        crewName: save.crewName, password: save.password,
        savedGame: save.game,
        savedMissionNumber: save.missionNumber || 1,
        members: { [myId]: { name: name.trim(), seat: 0 } },
        game: null,
      };
      await writeRoom(code, room0);
      setRoomCode(code); setRoom(room0); setScreen('lobby');
    } catch (e) {
      setError('이어하기에 실패했어요: ' + (e.message || '알 수 없는 오류'));
    }
    setBusy(false);
  };

  const handleJoin = async () => {
    if (!name.trim() || !roomCodeInput.trim()) { setError('이름과 방 코드를 입력해주세요'); return; }
    setError('');
    setBusy(true);
    const code = roomCodeInput.trim();
    const r = await readRoom(code);
    if (!r) { setBusy(false); setError('방을 찾을 수 없어요'); return; }
    const members = r.members || {};
    if (members[myId]) { setBusy(false); setRoomCode(code); setRoom(r); setScreen(r.started ? 'game' : 'lobby'); return; }
    if (r.started) { setBusy(false); setError('이미 시작된 게임이에요'); return; }
    const used = Object.values(members).map((m) => m.seat);
    if (used.length >= r.numPlayers) { setBusy(false); setError('방이 가득 찼어요'); return; }
    let seat = 0; while (used.includes(seat)) seat++;
    const updated = { ...r, members: { ...members, [myId]: { name: name.trim(), seat } } };
    await writeRoom(code, updated);
    setBusy(false);
    setRoomCode(code); setRoom(updated); setScreen('lobby');
  };

  const handleStartGame = async () => {
    setBusy(true);
    const r = await readRoom(roomCode);
    if (!r || r.hostId !== myId) { setBusy(false); return; }
    const members = r.members || {};
    const seatCount = Object.keys(members).length;
    if (seatCount !== r.numPlayers) { setBusy(false); setError(`${r.numPlayers}명이 모두 모여야 시작할 수 있어요 (현재 ${seatCount}명)`); return; }

    let g;
    if (r.savedGame) {
      // 이어하기: 저장된 게임 복원 후, 이번에 모인 사람들에게 좌석 재배정
      g = Game.fromJSON(r.savedGame);
      const seatList = Object.entries(members).sort((a, b) => a[1].seat - b[1].seat);
      seatList.forEach(([pid, m]) => g.assignSeat(m.seat, pid, m.name));
      // 저장 시점이 미션 종료 상태였다면 다음 미션 새로 시작
      if (g.phase === 'missionEnd' || !g.phase) {
        const nextNo = (r.savedMissionNumber || g.missionNumber || 1);
        const diff = CAMPAIGN_MISSIONS[Math.min(nextNo - 1, CAMPAIGN_MISSIONS.length - 1)];
        g.startMission(nextNo, diff);
      }
    } else {
      g = new Game(r.numPlayers, { rescueSignalEnabled: false });
      Object.entries(members).forEach(([pid, m]) => g.assignSeat(m.seat, pid, m.name));
      const difficulty = CAMPAIGN_MISSIONS[0];
      g.startMission(1, difficulty);
    }
    const updated = { ...r, started: true, game: g.toJSON() };
    await writeRoom(roomCode, updated);
    setBusy(false);
    setRoom(updated); setScreen('game');
  };

  // ---------- 게임 액션 (공통 헬퍼) ----------
  const mutate = async (fn) => {
    setBusy(true);
    const r = await readRoom(roomCode);
    const g = loadGame(r);
    if (!g) { setBusy(false); return; }
    try {
      fn(g, r);
      const updated = { ...r, game: g.toJSON() };
      await writeRoom(roomCode, updated);
      setRoom(updated);
    } catch (e) {
      setError(e.message || '동작을 수행할 수 없어요');
      setTimeout(() => setError(''), 2500);
    }
    setBusy(false);
  };

  const mySeat = () => {
    const g = loadGame(room);
    return g ? g.seatOfPlayer(myId) : -1;
  };

  const doChooseTask = (taskId) => mutate((g) => g.chooseTask(mySeatOf(g), taskId));
  const doPassTask = () => mutate((g) => g.passTaskSelection(mySeatOf(g)));
  const doPlayCard = (card) => mutate((g) => g.playCard(mySeatOf(g), card));
  const doCommunicate = (card) => mutate((g) => g.communicate(mySeatOf(g), card));
  const doNextMission = async () => {
    // 다음 미션으로 넘어가기 전에, 현재 크루 진행상황을 자동 저장
    const rNow = await readRoom(roomCode);
    if (rNow && rNow.crewName) {
      const gNow = loadGame(rNow);
      if (gNow) {
        await writeCrewSave(rNow.crewName, {
          crewName: rNow.crewName, password: rNow.password, numPlayers: rNow.numPlayers,
          missionNumber: (gNow.missionNumber || 1) + 1, // 다음 미션 번호
          game: gNow.toJSON(), savedAt: Date.now(),
        });
      }
    }
    mutate((g) => {
      const next = g.missionNumber + 1;
      const diff = CAMPAIGN_MISSIONS[Math.min(next - 1, CAMPAIGN_MISSIONS.length - 1)];
      g.startMission(next, diff);
    });
  };

  // 미션 패스(건너뛰기): 성공/실패 상관없이 다음 미션으로
  const doSkipMission = async () => {
    if (!window.confirm('이 미션을 패스하고 다음 미션으로 넘어갈까요?')) return;
    mutate((g) => {
      const next = (g.missionNumber || 1) + 1;
      const diff = CAMPAIGN_MISSIONS[Math.min(next - 1, CAMPAIGN_MISSIONS.length - 1)];
      g.startMission(next, diff);
    });
  };

  // 채팅 메시지 전송
  const sendChat = async () => {
    const text = chatInput.trim();
    if (!text) return;
    setChatInput('');
    const r = await readRoom(roomCode);
    if (!r) return;
    const myName = (r.members && r.members[myId] && r.members[myId].name) || '익명';
    const msg = { id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name: myName, text: text.slice(0, 200), ts: Date.now() };
    const chat = [...(r.chat || []), msg].slice(-50); // 최근 50개만 유지
    await writeRoom(roomCode, { ...r, chat });
    setRoom({ ...r, chat });
  };

  // 대기열(로비)로 돌아가기
  const handleBackToLobby = async () => {
    setBusy(true);
    const r = await readRoom(roomCode);
    if (r) {
      const updated = { ...r, started: false, game: null };
      // savedGame 등은 유지
      await writeRoom(roomCode, updated);
      setRoom(updated);
    }
    setScreen('lobby');
    setBusy(false);
  };
  const doRetry = () => mutate((g) => g.retryMission());
  const doPredict = (taskId, value) => mutate((g) => g.submitPrediction(mySeatOf(g), taskId, value));

  function mySeatOf(g) { return g.seatOfPlayer(myId); }

  const pageStyle = {
    minHeight: '100vh',
    background: 'radial-gradient(ellipse at 50% -10%, #123650 0%, #05121F 60%)',
    color: '#EAF6F6', fontFamily: "'Space Grotesk', sans-serif",
  };
  const headline = { fontFamily: "'Fraunces', serif", fontWeight: 600 };
  const fontStyle = `@import url('https://fonts.googleapis.com/css2?family=Black+Han+Sans&family=Fraunces:wght@500;600&family=Space+Grotesk:wght@400;500;700&display=swap'); *{box-sizing:border-box;} body{margin:0;} @keyframes floatUp { 0%{transform:translateY(0);opacity:0} 10%{opacity:0.5} 100%{transform:translateY(-320px);opacity:0} } @media (orientation: landscape) and (max-height: 550px) { .crew-table { height: 240px !important; } .crew-hand { max-height: 34vh !important; } .crew-scroll { padding-top: 8px !important; } }`;

  if (!authReady || !myId) {
    return <div style={{ ...pageStyle, display: 'flex', justifyContent: 'center' }}><div style={{ marginTop: 100, color: '#7FA6C2' }}>연결 중...</div></div>;
  }

  // ============ JOIN / LOBBY ============
  if (screen !== 'game' || !room || !room.started) {
    return (
      <div style={{
        position: 'relative', minHeight: '100vh', overflow: 'hidden',
        background: 'linear-gradient(180deg, #0a3a52 0%, #07293f 35%, #041824 70%, #020d15 100%)',
        color: '#EAF6F6', fontFamily: "'Space Grotesk', sans-serif",
        padding: '30px 16px 40px', display: 'flex', flexDirection: 'column', alignItems: 'center',
      }}>
        <style>{fontStyle}</style>

        {/* BGM 토글 */}
        <button onClick={ambience.toggle}
          style={{ position: 'fixed', top: 12, right: 12, zIndex: 10, width: 40, height: 40, borderRadius: 20, border: '1px solid rgba(120,200,230,0.3)', background: 'rgba(11,42,69,0.8)', color: '#7FBEDA', fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          title={ambience.playing ? '음악 끄기' : '음악 켜기'}>
          {ambience.playing ? '🔊' : '🔇'}
        </button>

        {/* 수면 광선 */}
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '60%', pointerEvents: 'none', opacity: 0.35,
          background: 'linear-gradient(100deg, transparent 20%, rgba(120,200,230,0.15) 30%, transparent 40%, rgba(120,200,230,0.12) 55%, transparent 65%, rgba(120,200,230,0.1) 78%, transparent 88%)' }} />
        {/* 떠오르는 기포들 */}
        {[...Array(14)].map((_, i) => {
          const size = 4 + (i % 4) * 3;
          const left = (i * 37) % 100;
          const delay = (i % 7) * 1.3;
          const dur = 7 + (i % 5) * 2;
          return <div key={i} style={{ position: 'absolute', bottom: 0, left: `${left}%`, width: size, height: size, borderRadius: '50%',
            background: 'rgba(160,220,240,0.4)', animation: `floatUp ${dur}s linear ${delay}s infinite`, pointerEvents: 'none' }} />;
        })}

        <div style={{ width: '100%', maxWidth: 440, position: 'relative', zIndex: 1 }}>
          <div style={{ textAlign: 'center', marginBottom: 30 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <SubmarineIcon flip style={{ opacity: 0.95, flexShrink: 0 }} />
              <div style={{
                fontFamily: "'Black Han Sans', sans-serif", fontSize: 56, lineHeight: 0.95,
                color: '#EAF6F6', letterSpacing: 1,
                textShadow: '0 2px 0 #0a3a52, 0 4px 18px rgba(0,0,0,0.6), 0 0 30px rgba(80,180,220,0.4)',
              }}>
                딥 씨<br />크루
              </div>
              <SubmarineIcon style={{ opacity: 0.95, flexShrink: 0 }} />
            </div>
            <div style={{ marginTop: 10, color: '#7FBEDA', fontSize: 15, letterSpacing: 6, fontWeight: 500 }}>심해에서의 임무</div>
          </div>

          {screen === 'join' && (
            <div style={{ background: 'rgba(11,42,69,0.85)', backdropFilter: 'blur(4px)', borderRadius: 16, padding: 22, border: '1px solid rgba(120,200,230,0.15)' }}>
              {/* 모드 탭 */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
                {[['new', '새 크루'], ['continue', '이어하기'], ['join', '방 참가']].map(([m, label]) => (
                  <button key={m} onClick={() => { setJoinMode(m); setError(''); }}
                    style={{ flex: 1, padding: 9, borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: 'pointer',
                      border: joinMode === m ? '2px solid #2FE6C7' : '1px solid rgba(255,255,255,0.15)',
                      background: joinMode === m ? 'rgba(47,230,199,0.12)' : '#0B2A45',
                      color: joinMode === m ? '#2FE6C7' : '#7FA6C2' }}>{label}</button>
                ))}
              </div>

              <label style={{ fontSize: 13, color: '#7FA6C2' }}>내 이름</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="닉네임"
                style={{ width: '100%', marginTop: 6, marginBottom: 16, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: '#0B2A45', color: '#EAF6F6', outline: 'none' }} />

              {/* 새 크루 */}
              {joinMode === 'new' && (
                <>
                  <label style={{ fontSize: 13, color: '#7FA6C2' }}>크루 이름</label>
                  <input value={crewName} onChange={(e) => setCrewName(e.target.value)} placeholder="예: 심해탐험대"
                    style={{ width: '100%', marginTop: 6, marginBottom: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: '#0B2A45', color: '#EAF6F6', outline: 'none' }} />
                  <label style={{ fontSize: 13, color: '#7FA6C2' }}>암호 (숫자 4자리 · 이어하기용)</label>
                  <input value={crewPassword} onChange={(e) => setCrewPassword(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="****" inputMode="numeric"
                    style={{ width: '100%', marginTop: 6, marginBottom: 16, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: '#0B2A45', color: '#EAF6F6', outline: 'none', letterSpacing: 4 }} />
                  <label style={{ fontSize: 13, color: '#7FA6C2' }}>인원 수</label>
                  <div style={{ display: 'flex', gap: 8, marginTop: 6, marginBottom: 16 }}>
                    {[3, 4, 5].map((n) => (
                      <button key={n} onClick={() => setNumPlayersInput(n)}
                        style={{ flex: 1, padding: 10, borderRadius: 10, border: numPlayersInput === n ? '2px solid #2FE6C7' : '1px solid rgba(255,255,255,0.15)', background: numPlayersInput === n ? 'rgba(47,230,199,0.12)' : '#0B2A45', color: numPlayersInput === n ? '#2FE6C7' : '#EAF6F6', fontWeight: 700, cursor: 'pointer' }}>{n}명</button>
                    ))}
                  </div>
                  <button onClick={handleCreate} disabled={busy} style={{ width: '100%', padding: 12, borderRadius: 10, border: 'none', background: '#2FE6C7', color: '#05121F', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>새 크루로 시작</button>
                </>
              )}

              {/* 이어하기 */}
              {joinMode === 'continue' && (
                <>
                  <label style={{ fontSize: 13, color: '#7FA6C2' }}>크루 이름</label>
                  <input value={crewName} onChange={(e) => setCrewName(e.target.value)} placeholder="저장했던 크루 이름"
                    style={{ width: '100%', marginTop: 6, marginBottom: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: '#0B2A45', color: '#EAF6F6', outline: 'none' }} />
                  <label style={{ fontSize: 13, color: '#7FA6C2' }}>암호 (숫자 4자리)</label>
                  <input value={crewPassword} onChange={(e) => setCrewPassword(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="****" inputMode="numeric"
                    style={{ width: '100%', marginTop: 6, marginBottom: 16, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: '#0B2A45', color: '#EAF6F6', outline: 'none', letterSpacing: 4 }} />
                  <button onClick={handleContinue} disabled={busy} style={{ width: '100%', padding: 12, borderRadius: 10, border: 'none', background: '#2FE6C7', color: '#05121F', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>이어하기</button>
                  <div style={{ fontSize: 11, color: '#4A6E85', marginTop: 10 }}>저장된 다음 미션부터 다시 시작해요. 참가자는 로비에서 다시 모이면 돼요.</div>
                </>
              )}

              {/* 방 참가 */}
              {joinMode === 'join' && (
                <>
                  <label style={{ fontSize: 13, color: '#7FA6C2' }}>방 코드</label>
                  <input value={roomCodeInput} onChange={(e) => setRoomCodeInput(e.target.value)} placeholder="4자리 코드"
                    style={{ width: '100%', marginTop: 6, marginBottom: 16, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: '#0B2A45', color: '#EAF6F6', outline: 'none' }} />
                  <button onClick={handleJoin} disabled={busy} style={{ width: '100%', padding: 12, borderRadius: 10, border: '1px solid #2FE6C7', background: 'transparent', color: '#2FE6C7', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>방 참가하기</button>
                  <div style={{ fontSize: 11, color: '#4A6E85', marginTop: 10 }}>친구가 만든 방 코드를 입력해 같은 크루에 합류해요.</div>
                </>
              )}

              {error && <div style={{ color: '#FF6FA5', fontSize: 13, marginTop: 14 }}>{error}</div>}
            </div>
          )}

          {screen === 'lobby' && room && (
            <div style={{ background: 'rgba(11,42,69,0.85)', backdropFilter: 'blur(4px)', borderRadius: 16, padding: 22, border: '1px solid rgba(120,200,230,0.15)' }}>
              <div style={{ textAlign: 'center', marginBottom: 18 }}>
                {room.crewName && <div style={{ ...headline, fontSize: 18, color: '#7FBEDA', marginBottom: 8 }}>🚩 {room.crewName}{room.savedGame ? ` · 미션 ${room.savedMissionNumber}부터` : ''}</div>}
                <div style={{ color: '#7FA6C2', fontSize: 13 }}>방 코드</div>
                <div style={{ ...headline, fontSize: 40, color: '#2FE6C7', letterSpacing: 4 }}>{roomCode}</div>
                <div style={{ color: '#4A6E85', fontSize: 12, marginTop: 4 }}>{room.numPlayers}명이 모여야 시작해요</div>
              </div>
              <div style={{ marginBottom: 18 }}>
                {Object.entries(room.members || {}).sort((a, b) => a[1].seat - b[1].seat).map(([pid, m]) => (
                  <div key={pid} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{ width: 8, height: 8, borderRadius: 4, background: '#2FE6C7' }} />
                    <span>좌석 {m.seat + 1} · {m.name}{pid === myId ? ' (나)' : ''}{pid === room.hostId ? ' 👑' : ''}</span>
                  </div>
                ))}
                {Array.from({ length: room.numPlayers - Object.keys(room.members || {}).length }).map((_, i) => (
                  <div key={`empty-${i}`} style={{ padding: '8px 0', color: '#4A6E85', fontSize: 13, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>비어있는 자리…</div>
                ))}
              </div>
              {room.hostId === myId ? (
                <button onClick={handleStartGame} disabled={busy || Object.keys(room.members || {}).length !== room.numPlayers}
                  style={{ width: '100%', padding: 12, borderRadius: 10, border: 'none', background: Object.keys(room.members || {}).length !== room.numPlayers ? '#284A5E' : '#2FE6C7', color: Object.keys(room.members || {}).length !== room.numPlayers ? '#7FA6C2' : '#05121F', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>
                  {Object.keys(room.members || {}).length !== room.numPlayers ? `${Object.keys(room.members || {}).length}/${room.numPlayers}명` : '게임 시작'}
                </button>
              ) : (
                <div style={{ textAlign: 'center', padding: 12, borderRadius: 10, background: 'rgba(255,255,255,0.04)', color: '#7FA6C2', fontSize: 14 }}>방장이 시작하길 기다리는 중...</div>
              )}
              {error && <div style={{ color: '#FF6FA5', fontSize: 13, marginTop: 14 }}>{error}</div>}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ============ GAME ============
  const g = loadGame(room);
  if (!g) return <div style={pageStyle}><div style={{ padding: 40 }}>게임 상태를 불러오는 중...</div></div>;
  const seat = g.seatOfPlayer(myId);
  const view = g.getStateFor(seat);
  const seatName = (s) => { const info = g.seats[s]; return info && info.name ? info.name : `좌석${s + 1}`; };

  const phase = view.phase;
  const myHand = view.myHand || [];
  const curTrick = view.currentTrick;
  const toAct = view.currentPlayerToAct;
  const isMyTurn = phase === 'playing' && toAct === seat && curTrick;
  const legalIds = isMyTurn ? new Set(g.legalCardsFor(seat).map((c) => `${c.suit}${c.value}`)) : new Set();

  const myTasks = view.taskPool.filter((t) => t.owner === seat);
  const captainName = view.captainSeat >= 0 ? seatName(view.captainSeat) : '-';

  const commUsed = (view.comm || {})[seat] && view.comm[seat].used;
  const canCommunicateNow = phase === 'playing' && curTrick && curTrick.plays.length === 0 && !commUsed && !view.missionModifiers.noCommunication;

  return (
    <div style={{ ...pageStyle, display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <style>{fontStyle}</style>

      <button onClick={ambience.toggle}
        style={{ position: 'fixed', top: 10, right: 10, zIndex: 20, width: 36, height: 36, borderRadius: 18, border: '1px solid rgba(120,200,230,0.3)', background: 'rgba(11,42,69,0.85)', color: '#7FBEDA', fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        title={ambience.playing ? '음악 끄기' : '음악 켜기'}>
        {ambience.playing ? '🔊' : '🔇'}
      </button>

      {/* 채팅 토글 버튼 */}
      <button onClick={() => setChatOpen((v) => !v)}
        style={{ position: 'fixed', top: 10, right: 54, zIndex: 20, width: 36, height: 36, borderRadius: 18, border: '1px solid rgba(120,200,230,0.3)', background: 'rgba(11,42,69,0.85)', color: '#7FBEDA', fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        title="채팅">
        💬{(room.chat && room.chat.length > 0) ? '' : ''}
      </button>

      {/* 채팅 패널 */}
      {chatOpen && (
        <div style={{ position: 'fixed', top: 54, right: 10, zIndex: 25, width: 260, maxWidth: '80vw', height: 340, maxHeight: '60vh', background: 'rgba(8,30,48,0.97)', borderRadius: 14, border: '1px solid rgba(120,200,230,0.25)', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 30px rgba(0,0,0,0.5)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#7FBEDA' }}>💬 채팅</span>
            <button onClick={() => setChatOpen(false)} style={{ background: 'transparent', border: 'none', color: '#7FA6C2', fontSize: 16, cursor: 'pointer' }}>✕</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(room.chat || []).length === 0 && <div style={{ color: '#4A6E85', fontSize: 12, textAlign: 'center', marginTop: 20 }}>아직 메시지가 없어요</div>}
            {(room.chat || []).map((m) => {
              const mine = room.members && room.members[myId] && room.members[myId].name === m.name;
              return (
                <div key={m.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
                  {!mine && <div style={{ fontSize: 10, color: '#7FA6C2', marginBottom: 2 }}>{m.name}</div>}
                  <div style={{ fontSize: 13, padding: '6px 10px', borderRadius: 10, background: mine ? '#2FE6C7' : 'rgba(255,255,255,0.08)', color: mine ? '#05121F' : '#EAF6F6', wordBreak: 'break-word' }}>{m.text}</div>
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 6, padding: 10, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendChat(); }} placeholder="메시지..."
              style={{ flex: 1, padding: '8px 10px', borderRadius: 9, border: '1px solid rgba(255,255,255,0.15)', background: '#0B2A45', color: '#EAF6F6', outline: 'none', fontSize: 13 }} />
            <button onClick={sendChat} style={{ padding: '8px 12px', borderRadius: 9, border: 'none', background: '#2FE6C7', color: '#05121F', fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>전송</button>
          </div>
        </div>
      )}

      <div className="crew-scroll" style={{ flex: 1, overflowY: 'auto', padding: '14px 14px 10px' }}>
        <div style={{ width: '100%', maxWidth: 480, margin: '0 auto' }}>
          {/* 헤더 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, color: '#7FA6C2', marginBottom: 4 }}>
            <span>임무 {view.missionNumber} · 난이도 {view.missionDifficulty}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>방 {roomCode}</span>
              {room.hostId === myId && (
                <button onClick={doSkipMission} disabled={busy}
                  style={{ fontSize: 11, padding: '3px 8px', borderRadius: 7, border: '1px solid rgba(240,184,74,0.4)', background: 'transparent', color: '#F0B84B', cursor: 'pointer' }}>
                  패스
                </button>
              )}
              {room.hostId === myId && (
                <button onClick={handleBackToLobby} disabled={busy}
                  style={{ fontSize: 11, padding: '3px 8px', borderRadius: 7, border: '1px solid rgba(255,255,255,0.2)', background: 'transparent', color: '#7FA6C2', cursor: 'pointer' }}>
                  대기열로
                </button>
              )}
            </div>
          </div>
          <div style={{ textAlign: 'center', fontSize: 11, color: '#4A6E85', marginBottom: 10 }}>
            {room.crewName ? `🚩 ${room.crewName} · ` : ''}⚓ 선장: {captainName}{view.attemptNumber > 1 ? ` · ${view.attemptNumber}번째 시도` : ''}
          </div>

          {/* 미션 목표 리스트 */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: '#7FA6C2', marginBottom: 6 }}>미션 과제 ({view.taskPool.length})</div>
            {view.taskPool.map((t) => {
              const owner = t.owner;
              const pointColor = t.status === 'success' ? '#2FE6C7' : t.status === 'fail' ? '#FF6FA5' : '#7FA6C2';
              const icon = t.status === 'success' ? '✅' : t.status === 'fail' ? '❌' : '';
              return (
                <div key={t.id} style={{
                  padding: '8px 10px', borderRadius: 9, marginBottom: 6, fontSize: 12.5, lineHeight: 1.4,
                  background: t.status === 'success' ? 'rgba(47,230,199,0.1)' : t.status === 'fail' ? 'rgba(255,111,165,0.1)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${owner === seat ? 'rgba(240,184,74,0.4)' : 'rgba(255,255,255,0.08)'}`,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ flex: 1 }}>{t.text}</span>
                    <span style={{ flexShrink: 0, color: pointColor, fontSize: 11 }}>
                      {owner !== null && owner !== undefined ? seatName(owner) : '미배정'} {icon}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* 과제 선택 단계 */}
          {phase === 'taskSelection' && (
            <div style={{ background: '#103552', borderRadius: 14, padding: 16, marginBottom: 12, border: '1px solid rgba(240,184,74,0.25)' }}>
              <div style={{ ...headline, fontSize: 16, color: '#F0B84B', marginBottom: 6 }}>과제 분배</div>
              <div style={{ fontSize: 12, color: '#7FA6C2', marginBottom: 10 }}>
                아래 내 손패를 보고 완수할 수 있는 과제를 가져가세요. 선장부터 순서대로 진행돼요.
              </div>
              <div style={{ textAlign: 'center', padding: 10, borderRadius: 10, background: view.currentTaskSelector === seat ? 'rgba(47,230,199,0.12)' : 'rgba(255,255,255,0.04)', color: view.currentTaskSelector === seat ? '#2FE6C7' : '#7FA6C2', fontSize: 14, fontWeight: 600, marginBottom: view.currentTaskSelector === seat ? 10 : 0 }}>
                {view.currentTaskSelector === seat ? '당신 차례 - 가져갈 과제를 고르세요' : `${seatName(view.currentTaskSelector)}님이 고르는 중...`}
              </div>
              {view.currentTaskSelector === seat && (
                <>
                  {view.unassignedTasks.map((id) => {
                    const t = TASKS_BY_ID[id];
                    const blocked = t.captainCannotOwn && seat === view.captainSeat;
                    return (
                      <button key={id} onClick={() => !blocked && doChooseTask(id)} disabled={busy || blocked}
                        style={{ width: '100%', textAlign: 'left', padding: '9px 11px', borderRadius: 9, marginBottom: 6, border: '1px solid rgba(47,230,199,0.35)', background: blocked ? 'rgba(255,255,255,0.03)' : 'rgba(47,230,199,0.06)', color: blocked ? '#4A6E85' : '#EAF6F6', cursor: blocked ? 'default' : 'pointer', fontSize: 12.5, fontFamily: 'inherit', lineHeight: 1.4 }}>
                        {t.text}{blocked ? ' (선장 선택 불가)' : ''}
                      </button>
                    );
                  })}
                  {view.canPassTaskSelection && (
                    <button onClick={doPassTask} disabled={busy} style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid rgba(255,255,255,0.2)', background: 'transparent', color: '#7FA6C2', fontSize: 13, cursor: 'pointer', marginTop: 4 }}>패스 (안 가져가기)</button>
                  )}
                </>
              )}
            </div>
          )}

          {/* (구조신호 기능은 사용하지 않음) */}


          {/* 예측 단계 */}
          {phase === 'prediction' && (
            <div style={{ background: '#103552', borderRadius: 14, padding: 16, marginBottom: 12, border: '1px solid rgba(240,184,74,0.3)' }}>
              <div style={{ ...headline, fontSize: 16, color: '#F0B84B', marginBottom: 8 }}>트릭 수 예측</div>
              {view.pendingPredictionTasks.filter((id) => view.taskPool.find((t) => t.id === id && t.owner === seat)).length === 0 ? (
                <div style={{ color: '#7FA6C2', fontSize: 13 }}>다른 인원이 예측을 입력하는 중...</div>
              ) : (
                view.pendingPredictionTasks.filter((id) => view.taskPool.find((t) => t.id === id && t.owner === seat)).map((id) => (
                  <div key={id}>
                    <div style={{ fontSize: 12.5, marginBottom: 8 }}>{TASKS_BY_ID[id].text}</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input value={predictInput} onChange={(e) => setPredictInput(e.target.value)} placeholder={`0~${view.lastTrickIndex}`} inputMode="numeric"
                        style={{ flex: 1, padding: 10, borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: '#0B2A45', color: '#EAF6F6', outline: 'none' }} />
                      <button onClick={() => { doPredict(id, parseInt(predictInput, 10)); setPredictInput(''); }} disabled={busy || predictInput === ''}
                        style={{ padding: '10px 16px', borderRadius: 10, border: 'none', background: '#2FE6C7', color: '#05121F', fontWeight: 700, cursor: 'pointer' }}>확정</button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* 진행 안내 (내 차례일 때만 강조) */}
          {phase === 'playing' && isMyTurn && (
            <div style={{ textAlign: 'center', marginBottom: 10, padding: 8, borderRadius: 10, background: 'rgba(47,230,199,0.12)', color: '#2FE6C7', fontSize: 14, fontWeight: 600 }}>
              지금 당신의 차례예요 — 아래에서 카드를 내세요
            </div>
          )}

          {/* 포커 스타일 테이블 */}
          {(phase === 'playing' || phase === 'missionEnd') && (() => {
            const positions = seatPositions(view.numPlayers, seat);
            const shownTrick = (curTrick && curTrick.plays.length > 0) ? curTrick : view.previousTrick;
            const playsBySeat = {};
            if (shownTrick) shownTrick.plays.forEach((p) => { playsBySeat[p.seat] = p.card; });
            const winnerSeat = shownTrick && !curTrick ? shownTrick.winnerSeat : (shownTrick && shownTrick.winnerSeat !== undefined ? shownTrick.winnerSeat : null);
            // 좌석별 미션 모으기
            const tasksBySeat = {};
            view.taskPool.forEach((t) => { if (t.owner !== null && t.owner !== undefined) { (tasksBySeat[t.owner] = tasksBySeat[t.owner] || []).push(t); } });
            return (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: '#7FA6C2', marginBottom: 6, textAlign: 'center' }}>
                  {curTrick ? `트릭 ${curTrick.trickIndex} / ${view.lastTrickIndex}` : (view.previousTrick ? `지난 트릭 ${view.previousTrick.trickIndex}` : '트릭')}
                </div>
                <div className="crew-table" style={{
                  position: 'relative', width: '100%', height: 360, borderRadius: 24, overflow: 'hidden',
                  background: 'linear-gradient(180deg, #0d4a68 0%, #0a3550 40%, #062536 100%)',
                  border: '2px solid rgba(120,200,230,0.15)', boxShadow: 'inset 0 0 60px rgba(0,0,0,0.5)',
                }}>
                  {/* 바다 배경 장식: 빛줄기 */}
                  <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', opacity: 0.25,
                    background: 'linear-gradient(105deg, transparent 25%, rgba(140,210,235,0.18) 35%, transparent 45%, rgba(140,210,235,0.12) 60%, transparent 72%)' }} />
                  {/* 기포 */}
                  {[...Array(10)].map((_, i) => {
                    const size = 3 + (i % 3) * 2; const left = (i * 29 + 5) % 100; const delay = (i % 5) * 1.1; const dur = 6 + (i % 4) * 2;
                    return <div key={`b${i}`} style={{ position: 'absolute', bottom: -10, left: `${left}%`, width: size, height: size, borderRadius: '50%', background: 'rgba(160,220,240,0.35)', animation: `floatUp ${dur}s linear ${delay}s infinite`, pointerEvents: 'none' }} />;
                  })}
                  {/* 잠수부 실루엣 (중앙 뒤편 장식) */}
                  <DiverSilhouette style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-55%) scale(1.4)', opacity: 0.4, pointerEvents: 'none' }} />

                  {/* 중앙 라벨 */}
                  <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,42px)', textAlign: 'center', color: 'rgba(255,255,255,0.35)', fontSize: 12, fontFamily: "'Fraunces', serif", pointerEvents: 'none' }}>
                    {shownTrick && shownTrick.leadSuit ? `리드: ${SUIT_INFO[shownTrick.leadSuit].label}` : ''}
                  </div>

                  {Array.from({ length: view.numPlayers }).map((_, s) => (
                    <TableSeat key={s} seat={s} pos={positions[s]} seatName={seatName(s)}
                      playedCard={playsBySeat[s]}
                      isToAct={phase === 'playing' && toAct === s && !!curTrick}
                      isWinner={winnerSeat === s && !!playsBySeat[s]}
                      isCaptain={view.captainSeat === s}
                      isMe={s === seat}
                      tasks={tasksBySeat[s]} />
                  ))}
                </div>
              </div>
            );
          })()}

          {/* 통신 정보 (통신한 카드 표시) */}
          {Object.entries(view.comm || {}).filter(([s, c]) => c && c.used).length > 0 && (
            <div style={{ marginBottom: 10, background: '#0E2C44', borderRadius: 12, padding: 12, border: '1px solid rgba(76,141,255,0.2)' }}>
              <div style={{ fontSize: 11, color: '#7FA6C2', marginBottom: 8 }}>📡 소나 통신</div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {Object.entries(view.comm).filter(([s, c]) => c && c.used).map(([s, c]) => (
                  <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ position: 'relative', opacity: c.active ? 1 : 0.4 }}>
                      <CardChip card={c.card} disabled />
                    </div>
                    <div style={{ fontSize: 11, color: '#EAF6F6' }}>
                      <div style={{ fontWeight: 700 }}>{seatName(Number(s))}</div>
                      <div style={{ color: '#F0B84B' }}>{c.position === 'HIGHEST' ? '이 색 최고' : c.position === 'LOWEST' ? '이 색 최저' : '이 색 유일'}</div>
                      {!c.active && <div style={{ color: '#4A6E85', fontSize: 10 }}>(이미 냄)</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 미션 종료 */}
          {phase === 'missionEnd' && (
            <div style={{ background: view.missionResult === 'success' ? 'rgba(47,230,199,0.1)' : 'rgba(255,111,165,0.1)', borderRadius: 16, padding: 20, border: `1px solid ${view.missionResult === 'success' ? 'rgba(47,230,199,0.3)' : 'rgba(255,111,165,0.3)'}`, marginBottom: 12, textAlign: 'center' }}>
              <div style={{ ...headline, fontSize: 20, marginBottom: 10, color: view.missionResult === 'success' ? '#2FE6C7' : '#FF6FA5' }}>
                {view.missionResult === 'success' ? `🎉 임무 ${view.missionNumber} 성공!` : `임무 ${view.missionNumber} 실패`}
              </div>
              {room.hostId === myId ? (
                view.missionResult === 'success' ? (
                  <button onClick={doNextMission} disabled={busy} style={{ padding: '10px 22px', borderRadius: 10, border: 'none', background: '#2FE6C7', color: '#05121F', fontWeight: 700, cursor: 'pointer' }}>다음 임무 (#{view.missionNumber + 1})</button>
                ) : (
                  <button onClick={doRetry} disabled={busy} style={{ padding: '10px 22px', borderRadius: 10, border: 'none', background: '#FF6FA5', color: '#05121F', fontWeight: 700, cursor: 'pointer' }}>같은 임무 다시 도전</button>
                )
              ) : <div style={{ color: '#7FA6C2', fontSize: 13 }}>방장이 다음 단계를 진행하길 기다리는 중...</div>}
            </div>
          )}
        </div>
      </div>

      {/* 하단 고정 손패 */}
      <div className="crew-hand" style={{ borderTop: '1px solid rgba(255,255,255,0.1)', background: '#0A2438', padding: '10px 14px 14px', maxHeight: '44vh', overflowY: 'auto' }}>
        <div style={{ width: '100%', maxWidth: 480, margin: '0 auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#7FA6C2', marginBottom: 6 }}>
            <span>내 손패 ({myHand.length}장){myTasks.length > 0 ? ` · 내 과제 ${myTasks.length}개` : ''}</span>
            {commUsed && <span style={{ color: '#4A6E85' }}>통신 사용함</span>}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {myHand.map((card) => {
              const cid = `${card.suit}${card.value}`;
              const playable = isMyTurn && legalIds.has(cid);
              return <CardChip key={cid} card={card} size="lg" dim={phase === 'playing' && !playable} onClick={playable ? () => doPlayCard(card) : undefined} />;
            })}
          </div>

          {/* 통신 버튼 */}
          {canCommunicateNow && (() => {
            // 통신 가능한 카드만 추림 (색깔별 최고/최저/유일)
            const colorCards = myHand.filter((c) => c.suit !== 'SUBMARINE');
            const bySuit = {};
            colorCards.forEach((c) => { (bySuit[c.suit] = bySuit[c.suit] || []).push(c); });
            const commOptions = [];
            Object.values(bySuit).forEach((cards) => {
              const vals = cards.map((c) => c.value);
              const max = Math.max(...vals), min = Math.min(...vals);
              cards.forEach((c) => {
                let pos = null;
                if (cards.length === 1) pos = '유일';
                else if (c.value === max) pos = '최고';
                else if (c.value === min) pos = '최저';
                if (pos) commOptions.push({ card: c, pos });
              });
            });
            return (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed rgba(255,255,255,0.1)' }}>
                <div style={{ fontSize: 11, color: '#F0B84B', marginBottom: 6 }}>📡 소나 통신 (임무당 1회 · 트릭 시작 전에만) — 아래 카드 중 하나를 눌러 알리기</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {commOptions.map(({ card, pos }) => (
                    <div key={`comm-${card.suit}${card.value}`} style={{ textAlign: 'center' }}>
                      <CardChip card={card} onClick={() => doCommunicate(card)} />
                      <div style={{ fontSize: 9, color: '#7FA6C2', marginTop: 2 }}>{pos}</div>
                    </div>
                  ))}
                  {commOptions.length === 0 && <div style={{ fontSize: 12, color: '#4A6E85' }}>통신 가능한 카드가 없어요 (최고/최저/유일 조건)</div>}
                </div>
              </div>
            );
          })()}

          {error && <div style={{ color: '#FF6FA5', fontSize: 12, marginTop: 8 }}>{error}</div>}
        </div>
      </div>
    </div>
  );
}
