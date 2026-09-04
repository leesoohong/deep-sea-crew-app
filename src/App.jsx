import React, { useState, useEffect } from 'react';
import { onAuthStateChanged, signInAnonymously } from 'firebase/auth';
import { ref, get, set, onValue } from 'firebase/database';
import { auth, db } from './firebase';

const SUITS = ['blue', 'green', 'yellow', 'pink'];
const SUIT_INFO = {
  blue: { label: '파랑', color: '#4C8DFF' },
  green: { label: '초록', color: '#3FCB82' },
  yellow: { label: '노랑', color: '#F2C94C' },
  pink: { label: '분홍', color: '#FF6FA5' },
  black: { label: '로켓', color: '#F0B84B' },
};

const MAX_TASK_COUNT = 6;
function taskCountForLevel(level) {
  return Math.min(level, MAX_TASK_COUNT);
}

function buildDeck() {
  const deck = [];
  SUITS.forEach((suit) => {
    for (let n = 1; n <= 9; n++) deck.push({ id: `${suit}-${n}`, suit, num: n });
  });
  for (let n = 1; n <= 4; n++) deck.push({ id: `black-${n}`, suit: 'black', num: n });
  return deck;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function playerName(room, id) {
  const p = room?.players.find((p) => p.id === id);
  return p ? p.name : '???';
}

function applyCardPlay(state, playerId, card) {
  const hand = (state.hands && state.hands[playerId]) || [];
  const newHand = hand.filter((c) => c.id !== card.id);
  const newHands = { ...(state.hands || {}), [playerId]: newHand };
  const newTrick = [...(state.trick || []), { playerId, card }];
  let updated = { ...state, hands: newHands, trick: newTrick };

  if (newTrick.length === state.turnOrder.length) {
    const leadSuit = newTrick[0].card.suit;
    const blacksPlayed = newTrick.filter((t) => t.card.suit === 'black');
    let winner;
    if (blacksPlayed.length > 0) {
      winner = blacksPlayed.reduce((a, b) => (a.card.num > b.card.num ? a : b));
    } else {
      const ledCards = newTrick.filter((t) => t.card.suit === leadSuit);
      winner = ledCards.reduce((a, b) => (a.card.num > b.card.num ? a : b));
    }

    // 목표 카드 판정: 그 카드를 낸 사람이 = 그 카드를 태스크로 가진 사람이 트릭을 이겨야 성공
    const targetCards = (state.targetCards || []).map((tc) => {
      if (tc.status !== 'pending') return tc;
      const playedInTrick = newTrick.find((t) => t.card.id === tc.id);
      if (!playedInTrick) return tc;
      // 이 목표 카드가 든 트릭을, 그 태스크의 주인이 이겨야 성공
      return { ...tc, status: winner.playerId === tc.ownerId ? 'success' : 'failed' };
    });
    const anyFailed = targetCards.some((tc) => tc.status === 'failed');
    const allDone = targetCards.every((tc) => tc.status !== 'pending');
    const allHaveCards = state.turnOrder.every((pid) => ((newHands[pid] || []).length > 0));

    let missionStatus = 'playing';
    if (anyFailed) missionStatus = 'failed';
    else if (allDone) missionStatus = 'success';
    else if (!allHaveCards) missionStatus = 'failed';

    updated = {
      ...updated,
      trickResult: { winnerId: winner.playerId, cards: newTrick },
      history: [...(state.history || []), { trickNumber: state.trickNumber, winnerId: winner.playerId }],
      targetCards,
      missionStatus,
      finished: missionStatus !== 'playing',
    };
  } else {
    updated = { ...updated, turnIndex: state.turnIndex + 1 };
  }
  return updated;
}

function nextTrickState(state) {
  const winnerIdx = state.turnOrder.indexOf(state.trickResult.winnerId);
  const reordered = [...state.turnOrder.slice(winnerIdx), ...state.turnOrder.slice(0, winnerIdx)];
  return { ...state, trick: [], trickResult: null, turnOrder: reordered, turnIndex: 0, trickNumber: state.trickNumber + 1 };
}

async function readRoom(code) {
  const snap = await get(ref(db, `rooms/${code}`));
  return snap.exists() ? snap.val() : null;
}
async function writeRoom(code, state) {
  await set(ref(db, `rooms/${code}`), state);
  return true;
}

function CardView({ card, disabled, onClick, size = 'md', highlighted }) {
  const info = SUIT_INFO[card.suit];
  const dims = size === 'lg' ? { w: 56, h: 78, fs: 22 } : { w: 42, h: 58, fs: 17 };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: dims.w, height: dims.h, borderRadius: 10,
        border: highlighted ? `2px solid #F0B84B` : `2px solid ${info.color}`,
        boxShadow: highlighted ? '0 0 0 3px rgba(240,184,74,0.35)' : 'none',
        background: card.suit === 'black' ? '#161C24' : `${info.color}1A`,
        color: info.color, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        opacity: disabled ? 0.35 : 1, flexShrink: 0,
        cursor: disabled ? 'default' : 'pointer', fontFamily: "'Space Grotesk', sans-serif",
      }}
    >
      <span style={{ fontSize: dims.fs, fontWeight: 700, lineHeight: 1 }}>{card.num}</span>
      <span style={{ fontSize: 9, marginTop: 3, letterSpacing: 0.5 }}>{info.label}</span>
    </button>
  );
}

function TaskBadge({ tc, room }) {
  const info = SUIT_INFO[tc.suit];
  const icon = tc.status === 'success' ? '✅' : tc.status === 'failed' ? '❌' : '';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5, padding: '5px 9px', borderRadius: 8,
      background: tc.status === 'success' ? 'rgba(47,230,199,0.12)' : tc.status === 'failed' ? 'rgba(255,111,165,0.12)' : 'rgba(255,255,255,0.05)',
      border: `1px solid ${tc.ownerId ? 'rgba(240,184,74,0.4)' : 'rgba(255,255,255,0.1)'}`,
    }}>
      <span style={{ color: info.color, fontWeight: 700, fontSize: 13 }}>{tc.num}</span>
      <span style={{ color: '#7FA6C2', fontSize: 11 }}>{info.label}</span>
      {tc.ownerId && <span style={{ color: '#F0B84B', fontSize: 10 }}>· {playerName(room, tc.ownerId)}</span>}
      {icon && <span style={{ fontSize: 11 }}>{icon}</span>}
    </div>
  );
}

export default function App() {
  const [myId, setMyId] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [screen, setScreen] = useState('join');
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [name, setName] = useState('');
  const [room, setRoom] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) { setMyId(user.uid); setAuthReady(true); }
      else signInAnonymously(auth).catch(() => setAuthReady(true));
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (screen === 'join' || !roomCode) return;
    const roomRef = ref(db, `rooms/${roomCode}`);
    const unsub = onValue(roomRef, (snap) => { if (snap.exists()) setRoom(snap.val()); });
    return () => unsub();
  }, [screen, roomCode]);

  const handleCreate = async () => {
    if (!name.trim()) { setError('이름을 입력해주세요'); return; }
    setError('');
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    const initial = {
      code, players: [{ id: myId, name: name.trim() }],
      phase: 'lobby', missionLevel: 1,
      hands: {}, trick: [], turnOrder: [], turnIndex: 0, trickNumber: 0,
      trickResult: null, targetCards: [], history: [], missionStatus: 'idle',
    };
    setBusy(true);
    const ok = await writeRoom(code, initial);
    setBusy(false);
    if (ok) { setRoomCode(code); setRoom(initial); setScreen('lobby'); }
    else setError('방 생성에 실패했어요. 다시 시도해주세요.');
  };

  const handleJoin = async () => {
    if (!name.trim() || !roomCodeInput.trim()) { setError('이름과 방 코드를 입력해주세요'); return; }
    setError('');
    setBusy(true);
    const code = roomCodeInput.trim();
    const r = await readRoom(code);
    if (!r) { setBusy(false); setError('방을 찾을 수 없어요'); return; }
    const existingPlayers = r.players || [];
    if (existingPlayers.some((p) => p.id === myId)) {
      setBusy(false); setRoomCode(code); setRoom(r); setScreen('lobby'); return;
    }
    if (r.phase && r.phase !== 'lobby') { setBusy(false); setError('이미 미션이 진행 중이에요'); return; }
    const updated = { ...r, players: [...existingPlayers, { id: myId, name: name.trim() }] };
    const ok = await writeRoom(code, updated);
    setBusy(false);
    if (ok) { setRoomCode(code); setRoom(updated); setScreen('lobby'); }
    else setError('참가에 실패했어요. 다시 시도해주세요.');
  };

  // 미션 준비: 카드 딜 + 캡틴 결정 + 목표카드 뽑기 → 태스크 드래프트 단계로
  const startMission = async (level) => {
    setBusy(true);
    const r = await readRoom(roomCode);
    const players = r ? r.players || [] : [];
    if (!r || players.length < 2) { setBusy(false); return; }
    if (players[0]?.id !== myId) { setBusy(false); return; }

    const deck = shuffle(buildDeck());
    const hands = {};
    players.forEach((p) => (hands[p.id] = []));
    deck.forEach((card, i) => { hands[players[i % players.length].id].push(card); });
    Object.keys(hands).forEach((pid) => {
      hands[pid].sort((a, b) => (a.suit === b.suit ? a.num - b.num : a.suit.localeCompare(b.suit)));
    });

    const captainId = Object.keys(hands).find((pid) => hands[pid].some((c) => c.suit === 'black' && c.num === 4));
    let turnOrder = players.map((p) => p.id);
    if (captainId) {
      const idx = turnOrder.indexOf(captainId);
      turnOrder = [...turnOrder.slice(idx), ...turnOrder.slice(0, idx)];
    }

    const colorCards = deck.filter((c) => c.suit !== 'black');
    const count = taskCountForLevel(level);
    const chosen = shuffle(colorCards).slice(0, count);
    const targetCards = chosen.map((c) => ({ id: c.id, suit: c.suit, num: c.num, ownerId: null, status: 'pending' }));

    const updated = {
      ...r, players, phase: 'draft', missionLevel: level, missionStatus: 'playing',
      hands, trick: [], turnOrder,
      captainId: captainId || turnOrder[0],
      draftIndex: 0, // turnOrder 상의 현재 태스크 고르는 사람
      turnIndex: 0, trickNumber: 1, trickResult: null, targetCards, history: [],
    };
    await writeRoom(roomCode, updated);
    setRoom(updated);
    setScreen('game');
    setBusy(false);
  };

  // 태스크 하나를 현재 순번인 사람이 가져감
  const claimTask = async (taskId) => {
    setBusy(true);
    const r = await readRoom(roomCode);
    if (!r || r.phase !== 'draft') { setBusy(false); return; }
    const order = r.turnOrder || [];
    const currentPicker = order[(r.draftIndex || 0) % order.length];
    if (currentPicker !== myId) { setBusy(false); return; }
    const targetCards = (r.targetCards || []).map((tc) => tc.id === taskId && !tc.ownerId ? { ...tc, ownerId: myId } : tc);
    const remaining = targetCards.filter((tc) => !tc.ownerId).length;
    let updated = { ...r, targetCards, draftIndex: (r.draftIndex || 0) + 1 };
    if (remaining === 0) { updated.phase = 'play'; }
    await writeRoom(roomCode, updated);
    setRoom(updated);
    setBusy(false);
  };

  // 패스 (태스크 수 < 사람 수 일 때만 허용)
  const passTask = async () => {
    setBusy(true);
    const r = await readRoom(roomCode);
    if (!r || r.phase !== 'draft') { setBusy(false); return; }
    const order = r.turnOrder || [];
    const currentPicker = order[(r.draftIndex || 0) % order.length];
    if (currentPicker !== myId) { setBusy(false); return; }
    const updated = { ...r, draftIndex: (r.draftIndex || 0) + 1 };
    await writeRoom(roomCode, updated);
    setRoom(updated);
    setBusy(false);
  };

  useEffect(() => {
    if (room && room.phase && room.phase !== 'lobby' && screen === 'lobby') setScreen('game');
  }, [room, screen]);

  const myHand = room ? (room.hands && room.hands[myId]) || [] : [];
  const roomTrick = room ? room.trick || [] : [];
  const ledSuit = roomTrick.length > 0 ? roomTrick[0].card.suit : null;
  const roomTurnOrder = room ? room.turnOrder || [] : [];
  const roomTargetCards = room ? room.targetCards || [] : [];
  const inPlay = room && room.phase === 'play' && room.missionStatus === 'playing';
  const myTurn = inPlay && !room.trickResult && roomTurnOrder[room.turnIndex] === myId;

  // 드래프트 관련
  const draftPickerId = room && room.phase === 'draft' ? roomTurnOrder[(room.draftIndex || 0) % (roomTurnOrder.length || 1)] : null;
  const myDraftTurn = room && room.phase === 'draft' && draftPickerId === myId;
  const remainingTasks = roomTargetCards.filter((tc) => !tc.ownerId);
  const canPass = room && remainingTasks.length < (roomTurnOrder.length || 0); // 태스크 < 사람수일 때만 패스 허용

  const canPlay = (card) => {
    if (!ledSuit) return true;
    if (card.suit === ledSuit) return true;
    return !myHand.some((c) => c.suit === ledSuit);
  };

  const playCard = async (card) => {
    if (busy || !myTurn || !canPlay(card)) return;
    setBusy(true);
    const r = await readRoom(roomCode);
    const rTurnOrder = r ? r.turnOrder || [] : [];
    if (!r || rTurnOrder[r.turnIndex] !== myId) { setBusy(false); return; }
    const rTrick = r.trick || [];
    const led = rTrick.length > 0 ? rTrick[0].card.suit : null;
    const hand = (r.hands && r.hands[myId]) || [];
    if (led && card.suit !== led && hand.some((c) => c.suit === led)) { setBusy(false); return; }
    const updated = applyCardPlay(r, myId, card);
    await writeRoom(roomCode, updated);
    setRoom(updated);
    setBusy(false);
  };

  const nextTrick = async () => {
    setBusy(true);
    const r = await readRoom(roomCode);
    if (!r || !r.trickResult) { setBusy(false); return; }
    const updated = nextTrickState(r);
    await writeRoom(roomCode, updated);
    setRoom(updated);
    setBusy(false);
  };

  const pageStyle = {
    minHeight: '100vh',
    background: 'radial-gradient(ellipse at 50% -10%, #123650 0%, #05121F 60%)',
    color: '#EAF6F6', fontFamily: "'Space Grotesk', sans-serif",
  };
  const headline = { fontFamily: "'Fraunces', serif", fontWeight: 600 };
  const isHost = room && room.players && room.players[0]?.id === myId;

  if (!authReady || !myId) {
    return (
      <div style={{ ...pageStyle, display: 'flex', justifyContent: 'center' }}>
        <div style={{ marginTop: 100, color: '#7FA6C2' }}>연결 중...</div>
      </div>
    );
  }

  // ===== JOIN / LOBBY (중앙 정렬 단순 레이아웃) =====
  if (screen !== 'game' || !room) {
    return (
      <div style={{ ...pageStyle, padding: '24px 16px 40px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@500;600&family=Space+Grotesk:wght@400;500;700&display=swap'); *{box-sizing:border-box;} body{margin:0;}`}</style>
        <div style={{ width: '100%', maxWidth: 420 }}>
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <div style={{ ...headline, fontSize: 30, letterSpacing: 0.5 }}>딥 씨 크루</div>
            <div style={{ color: '#7FA6C2', fontSize: 13, marginTop: 4 }}>협동 트릭테이킹 · 미션 레벨전</div>
          </div>

          {screen === 'join' && (
            <div style={{ background: '#103552', borderRadius: 16, padding: 22, border: '1px solid rgba(255,255,255,0.08)' }}>
              <label style={{ fontSize: 13, color: '#7FA6C2' }}>이름</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="닉네임"
                style={{ width: '100%', marginTop: 6, marginBottom: 18, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: '#0B2A45', color: '#EAF6F6', outline: 'none' }} />
              <button onClick={handleCreate} disabled={busy} style={{ width: '100%', padding: 12, borderRadius: 10, border: 'none', background: '#2FE6C7', color: '#05121F', fontWeight: 700, fontSize: 15, marginBottom: 18, cursor: 'pointer' }}>새 방 만들기</button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#4A6E85', fontSize: 12, marginBottom: 18 }}>
                <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.1)' }} />또는<div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.1)' }} />
              </div>
              <label style={{ fontSize: 13, color: '#7FA6C2' }}>방 코드로 참가</label>
              <input value={roomCodeInput} onChange={(e) => setRoomCodeInput(e.target.value)} placeholder="4자리 코드"
                style={{ width: '100%', marginTop: 6, marginBottom: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: '#0B2A45', color: '#EAF6F6', outline: 'none' }} />
              <button onClick={handleJoin} disabled={busy} style={{ width: '100%', padding: 12, borderRadius: 10, border: '1px solid #2FE6C7', background: 'transparent', color: '#2FE6C7', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>참가하기</button>
              {error && <div style={{ color: '#FF6FA5', fontSize: 13, marginTop: 14 }}>{error}</div>}
            </div>
          )}

          {screen === 'lobby' && room && (
            <div style={{ background: '#103552', borderRadius: 16, padding: 22, border: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ textAlign: 'center', marginBottom: 20 }}>
                <div style={{ color: '#7FA6C2', fontSize: 13 }}>방 코드</div>
                <div style={{ ...headline, fontSize: 40, color: '#2FE6C7', letterSpacing: 4 }}>{roomCode}</div>
                <div style={{ color: '#4A6E85', fontSize: 12, marginTop: 4 }}>친구들에게 이 코드를 알려주세요</div>
              </div>
              <div style={{ textAlign: 'center', marginBottom: 20, padding: '10px', borderRadius: 10, background: 'rgba(240,184,74,0.1)', color: '#F0B84B', fontWeight: 700, fontSize: 14 }}>
                레벨 {room.missionLevel || 1} · 목표 카드 {taskCountForLevel(room.missionLevel || 1)}장
              </div>
              <div style={{ marginBottom: 20 }}>
                {room.players.map((p) => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{ width: 8, height: 8, borderRadius: 4, background: '#2FE6C7' }} />
                    <span>{p.name}{p.id === myId ? ' (나)' : ''}{p.id === room.players[0]?.id ? ' 👑' : ''}</span>
                  </div>
                ))}
              </div>
              {isHost ? (
                <button onClick={() => startMission(room.missionLevel || 1)} disabled={busy || room.players.length < 2}
                  style={{ width: '100%', padding: 12, borderRadius: 10, border: 'none', background: room.players.length < 2 ? '#284A5E' : '#2FE6C7', color: room.players.length < 2 ? '#7FA6C2' : '#05121F', fontWeight: 700, fontSize: 15, cursor: room.players.length < 2 ? 'default' : 'pointer' }}>
                  {room.players.length < 2 ? '2명 이상 모이면 시작 가능' : `레벨 ${room.missionLevel || 1} 미션 시작 (${room.players.length}명)`}
                </button>
              ) : (
                <div style={{ textAlign: 'center', padding: 12, borderRadius: 10, background: 'rgba(255,255,255,0.04)', color: '#7FA6C2', fontSize: 14 }}>
                  방장({room.players[0]?.name})님이 시작하길 기다리는 중...
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ===== GAME (상단 스크롤 영역 + 하단 고정 손패) =====
  return (
    <div style={{ ...pageStyle, display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@500;600&family=Space+Grotesk:wght@400;500;700&display=swap'); *{box-sizing:border-box;} body{margin:0;}`}</style>

      {/* 스크롤 가능한 상단 영역 */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 16px 12px' }}>
        <div style={{ width: '100%', maxWidth: 460, margin: '0 auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#7FA6C2', marginBottom: 6 }}>
            <span>레벨 {room.missionLevel || 1} · 트릭 {room.trickNumber}</span>
            <span>방 {roomCode}</span>
          </div>
          {room.captainId && (
            <div style={{ textAlign: 'center', fontSize: 11, color: '#4A6E85', marginBottom: 12 }}>
              ⚓ 캡틴: {playerName(room, room.captainId)}
            </div>
          )}

          {/* 미션 목표 카드 목록 */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: '#7FA6C2', marginBottom: 8 }}>미션 목표 카드 - 이 카드로 트릭을 이겨야 해요</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {roomTargetCards.map((tc) => <TaskBadge key={tc.id} tc={tc} room={room} />)}
            </div>
          </div>

          {/* 드래프트(태스크 분배) 단계 */}
          {room.phase === 'draft' && (
            <div style={{ background: '#103552', borderRadius: 14, padding: 16, marginBottom: 16, border: '1px solid rgba(240,184,74,0.25)' }}>
              <div style={{ ...headline, fontSize: 16, color: '#F0B84B', marginBottom: 6 }}>태스크 분배</div>
              <div style={{ fontSize: 12, color: '#7FA6C2', marginBottom: 12 }}>
                캡틴부터 순서대로 목표 카드를 하나씩 가져가요. {canPass ? '(원하지 않으면 패스 가능)' : '(태스크가 인원 수 이상이라 패스 불가)'}
              </div>
              <div style={{ textAlign: 'center', padding: 10, borderRadius: 10, background: myDraftTurn ? 'rgba(47,230,199,0.12)' : 'rgba(255,255,255,0.04)', color: myDraftTurn ? '#2FE6C7' : '#7FA6C2', fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
                {myDraftTurn ? '당신 차례 - 가져갈 목표 카드를 고르세요' : `${playerName(room, draftPickerId)}님이 고르는 중...`}
              </div>
              {myDraftTurn && (
                <>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                    {remainingTasks.map((tc) => (
                      <button key={tc.id} onClick={() => claimTask(tc.id)} disabled={busy}
                        style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '8px 12px', borderRadius: 8, border: `2px solid ${SUIT_INFO[tc.suit].color}`, background: `${SUIT_INFO[tc.suit].color}1A`, color: SUIT_INFO[tc.suit].color, fontWeight: 700, cursor: 'pointer' }}>
                        {tc.num} {SUIT_INFO[tc.suit].label}
                      </button>
                    ))}
                  </div>
                  {canPass && (
                    <button onClick={passTask} disabled={busy} style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid rgba(255,255,255,0.2)', background: 'transparent', color: '#7FA6C2', fontSize: 13, cursor: 'pointer' }}>
                      패스 (안 가져가기)
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {/* 진행 중 안내 */}
          {inPlay && (
            <div style={{ textAlign: 'center', marginBottom: 14, padding: 10, borderRadius: 10, background: myTurn ? 'rgba(47,230,199,0.12)' : 'rgba(255,255,255,0.04)', color: myTurn ? '#2FE6C7' : '#7FA6C2', fontSize: 14, fontWeight: 600 }}>
              {room.trickResult ? '트릭 결과 확인' : myTurn ? '지금 당신의 차례예요' : `${playerName(room, roomTurnOrder[room.turnIndex])}님의 차례`}
            </div>
          )}

          {/* 현재 트릭 */}
          {room.phase !== 'draft' && (
            <div style={{ background: '#103552', borderRadius: 16, padding: 16, minHeight: 110, marginBottom: 14, border: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ fontSize: 12, color: '#7FA6C2', marginBottom: 10 }}>{!inPlay ? '마지막 트릭' : '현재 트릭'}</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {(room.trickResult ? room.trickResult.cards : roomTrick).map((t) => (
                  <div key={t.playerId} style={{ textAlign: 'center' }}>
                    <CardView card={t.card} disabled />
                    <div style={{ fontSize: 11, color: '#7FA6C2', marginTop: 4 }}>{playerName(room, t.playerId)}</div>
                  </div>
                ))}
                {roomTrick.length === 0 && !room.trickResult && inPlay && (
                  <div style={{ color: '#4A6E85', fontSize: 13 }}>아직 낸 카드가 없어요</div>
                )}
              </div>
            </div>
          )}

          {room.trickResult && inPlay && (
            <div style={{ textAlign: 'center', marginBottom: 16 }}>
              <div style={{ color: '#2FE6C7', fontWeight: 700, marginBottom: 10 }}>
                {playerName(room, room.trickResult.winnerId)}님이 트릭을 가져갔어요
              </div>
              <button onClick={nextTrick} disabled={busy} style={{ padding: '10px 22px', borderRadius: 10, border: 'none', background: '#2FE6C7', color: '#05121F', fontWeight: 700, cursor: 'pointer' }}>다음 트릭</button>
            </div>
          )}

          {room.missionStatus === 'success' && (
            <div style={{ background: 'rgba(47,230,199,0.1)', borderRadius: 16, padding: 20, border: '1px solid rgba(47,230,199,0.3)', marginBottom: 16, textAlign: 'center' }}>
              <div style={{ ...headline, fontSize: 20, marginBottom: 10, color: '#2FE6C7' }}>🎉 레벨 {room.missionLevel} 성공!</div>
              {isHost ? (
                <button onClick={() => startMission((room.missionLevel || 1) + 1)} disabled={busy} style={{ padding: '10px 22px', borderRadius: 10, border: 'none', background: '#2FE6C7', color: '#05121F', fontWeight: 700, cursor: 'pointer' }}>
                  다음 미션 (레벨 {(room.missionLevel || 1) + 1})
                </button>
              ) : <div style={{ color: '#7FA6C2', fontSize: 13 }}>방장이 다음 미션을 시작하길 기다리는 중...</div>}
            </div>
          )}

          {room.missionStatus === 'failed' && (
            <div style={{ background: 'rgba(255,111,165,0.1)', borderRadius: 16, padding: 20, border: '1px solid rgba(255,111,165,0.3)', marginBottom: 16, textAlign: 'center' }}>
              <div style={{ ...headline, fontSize: 20, marginBottom: 10, color: '#FF6FA5' }}>미션 실패 - 레벨 {room.missionLevel}</div>
              {isHost ? (
                <button onClick={() => startMission(room.missionLevel || 1)} disabled={busy} style={{ padding: '10px 22px', borderRadius: 10, border: 'none', background: '#FF6FA5', color: '#05121F', fontWeight: 700, cursor: 'pointer' }}>같은 레벨 다시 도전</button>
              ) : <div style={{ color: '#7FA6C2', fontSize: 13 }}>방장이 재도전을 시작하길 기다리는 중...</div>}
            </div>
          )}
        </div>
      </div>

      {/* 하단 고정 손패 */}
      {room.phase !== 'draft' && inPlay && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', background: '#0A2438', padding: '10px 16px 14px' }}>
          <div style={{ width: '100%', maxWidth: 460, margin: '0 auto' }}>
            <div style={{ fontSize: 11, color: '#7FA6C2', marginBottom: 6 }}>
              내 손패 ({myHand.length}장) · 금색 테두리 = 내가 챙겨야 할 목표 카드
            </div>
            <div style={{ display: 'flex', gap: 7, overflowX: 'auto', paddingBottom: 4 }}>
              {myHand.map((card) => (
                <CardView key={card.id} card={card} size="lg"
                  highlighted={roomTargetCards.some((tc) => tc.id === card.id && tc.ownerId === myId && tc.status === 'pending')}
                  disabled={!myTurn || !!room.trickResult || !canPlay(card)}
                  onClick={() => playCard(card)} />
              ))}
            </div>
            {ledSuit && !room.trickResult && (
              <div style={{ fontSize: 11, color: '#4A6E85', marginTop: 6 }}>
                리드 수트: {SUIT_INFO[ledSuit].label} (가능하면 같은 수트를 내야 해요)
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
