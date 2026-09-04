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

    // 이번 트릭에 목표 카드가 있었다면, 그 카드를 낸 사람이 트릭을 이겼는지로 성공/실패 판정
    const targetCards = (state.targetCards || []).map((tc) => {
      if (tc.status !== 'pending') return tc;
      const playedInTrick = newTrick.find((t) => t.card.id === tc.id);
      if (!playedInTrick) return tc;
      return { ...tc, status: playedInTrick.playerId === winner.playerId ? 'success' : 'failed' };
    });
    const anyFailed = targetCards.some((tc) => tc.status === 'failed');
    const allDone = targetCards.every((tc) => tc.status !== 'pending');

    // 모든 플레이어가 낼 카드가 남아있어야 다음 트릭이 가능하다.
    const allHaveCards = state.turnOrder.every((pid) => ((newHands[pid] || []).length > 0));

    let missionStatus = 'playing';
    if (anyFailed) missionStatus = 'failed';
    else if (allDone) missionStatus = 'success';
    else if (!allHaveCards) missionStatus = 'failed'; // 카드가 떨어질 때까지 목표를 못 채우면 실패

    updated = {
      ...updated,
      trickResult: { winnerId: winner.playerId, cards: newTrick },
      history: [...(state.history || []), { trickNumber: state.trickNumber, winnerId: winner.playerId, cards: newTrick }],
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
  const dims = size === 'lg' ? { w: 64, h: 90, fs: 26 } : { w: 44, h: 62, fs: 18 };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: dims.w,
        height: dims.h,
        borderRadius: 10,
        border: highlighted ? `2px solid #F0B84B` : `2px solid ${info.color}`,
        boxShadow: highlighted ? '0 0 0 3px rgba(240,184,74,0.35)' : 'none',
        background: card.suit === 'black' ? '#161C24' : `${info.color}1A`,
        color: info.color,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.35 : 1,
        flexShrink: 0,
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: "'Space Grotesk', sans-serif",
      }}
    >
      <span style={{ fontSize: dims.fs, fontWeight: 700, lineHeight: 1 }}>{card.num}</span>
      <span style={{ fontSize: 9, marginTop: 3, letterSpacing: 0.5 }}>{info.label}</span>
    </button>
  );
}

function TaskBadge({ tc }) {
  const info = SUIT_INFO[tc.suit];
  const icon = tc.status === 'success' ? '✅' : tc.status === 'failed' ? '❌' : '⏳';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 9px',
        borderRadius: 8,
        background: tc.status === 'success' ? 'rgba(47,230,199,0.12)' : tc.status === 'failed' ? 'rgba(255,111,165,0.12)' : 'rgba(255,255,255,0.05)',
        border: `1px solid ${tc.status === 'pending' ? 'rgba(255,255,255,0.1)' : 'transparent'}`,
      }}
    >
      <span style={{ fontSize: 12 }}>{icon}</span>
      <span style={{ color: info.color, fontWeight: 700, fontSize: 13 }}>{tc.num}</span>
      <span style={{ color: '#7FA6C2', fontSize: 11 }}>{info.label}</span>
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
      if (user) {
        setMyId(user.uid);
        setAuthReady(true);
      } else {
        signInAnonymously(auth).catch(() => setAuthReady(true));
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (screen === 'join' || !roomCode) return;
    const roomRef = ref(db, `rooms/${roomCode}`);
    const unsub = onValue(roomRef, (snap) => {
      if (snap.exists()) setRoom(snap.val());
    });
    return () => unsub();
  }, [screen, roomCode]);

  const handleCreate = async () => {
    if (!name.trim()) { setError('이름을 입력해주세요'); return; }
    setError('');
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    const initial = {
      code,
      players: [{ id: myId, name: name.trim() }],
      started: false,
      missionLevel: 1,
      missionStatus: 'idle',
      hands: {},
      trick: [],
      turnOrder: [],
      turnIndex: 0,
      trickNumber: 0,
      trickResult: null,
      targetCards: [],
      history: [],
      finished: false,
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
    if (r.started && r.missionStatus === 'playing') { setBusy(false); setError('이미 미션이 진행 중이에요'); return; }
    const updated = { ...r, players: [...existingPlayers, { id: myId, name: name.trim() }] };
    const ok = await writeRoom(code, updated);
    setBusy(false);
    if (ok) { setRoomCode(code); setRoom(updated); setScreen(r.started ? 'game' : 'lobby'); }
    else setError('참가에 실패했어요. 다시 시도해주세요.');
  };

  // level을 받아 새 미션을 딜하고 시작한다 (첫 시작/다음 미션/재도전 공용)
  const startMission = async (level) => {
    setBusy(true);
    const r = await readRoom(roomCode);
    const players = r ? r.players || [] : [];
    if (!r || players.length < 2) { setBusy(false); return; }
    if (players[0]?.id !== myId) { setBusy(false); return; }

    const deck = shuffle(buildDeck());
    const hands = {};
    players.forEach((p) => (hands[p.id] = []));
    deck.forEach((card, i) => {
      const p = players[i % players.length];
      hands[p.id].push(card);
    });
    Object.keys(hands).forEach((pid) => {
      hands[pid].sort((a, b) => (a.suit === b.suit ? a.num - b.num : a.suit.localeCompare(b.suit)));
    });

    // 잠수함(로켓) 4번 카드를 가진 사람이 캡틴 - 첫 트릭을 리드한다
    const captainId = Object.keys(hands).find((pid) => hands[pid].some((c) => c.suit === 'black' && c.num === 4));
    let turnOrder = players.map((p) => p.id);
    if (captainId) {
      const idx = turnOrder.indexOf(captainId);
      turnOrder = [...turnOrder.slice(idx), ...turnOrder.slice(0, idx)];
    }

    // 목표 카드(태스크) 뽑기 - 로켓(트럼프)은 항상 이기기 쉬워 난이도가 안 생기므로 색깔 카드 중에서만 선택
    const colorCards = deck.filter((c) => c.suit !== 'black');
    const count = taskCountForLevel(level);
    const chosen = shuffle(colorCards).slice(0, count);
    const targetCards = chosen.map((c) => ({ id: c.id, suit: c.suit, num: c.num, status: 'pending' }));

    const updated = {
      ...r,
      players,
      started: true,
      missionLevel: level,
      missionStatus: 'playing',
      hands,
      trick: [],
      turnOrder,
      captainId: captainId || turnOrder[0],
      turnIndex: 0,
      trickNumber: 1,
      trickResult: null,
      targetCards,
      history: [],
      finished: false,
    };
    await writeRoom(roomCode, updated);
    setRoom(updated);
    setScreen('game');
    setBusy(false);
  };

  useEffect(() => {
    if (room?.started && screen === 'lobby') setScreen('game');
  }, [room, screen]);

  const myHand = room ? (room.hands && room.hands[myId]) || [] : [];
  const roomTrick = room ? room.trick || [] : [];
  const ledSuit = roomTrick.length > 0 ? roomTrick[0].card.suit : null;
  const roomTurnOrder = room ? room.turnOrder || [] : [];
  const roomTargetCards = room ? room.targetCards || [] : [];
  const missionActive = room && room.started && room.missionStatus === 'playing';
  const myTurn = missionActive && !room.trickResult && roomTurnOrder[room.turnIndex] === myId;

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

  const wrapStyle = {
    minHeight: '100vh',
    background: 'radial-gradient(ellipse at 50% -10%, #123650 0%, #05121F 60%)',
    color: '#EAF6F6',
    fontFamily: "'Space Grotesk', sans-serif",
    padding: '24px 16px 40px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  };
  const headline = { fontFamily: "'Fraunces', serif", fontWeight: 600 };
  const isHost = room && room.players && room.players[0]?.id === myId;

  if (!authReady || !myId) {
    return (
      <div style={wrapStyle}>
        <div style={{ marginTop: 100, color: '#7FA6C2' }}>연결 중...</div>
      </div>
    );
  }

  return (
    <div style={wrapStyle}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@500;600&family=Space+Grotesk:wght@400;500;700&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }
      `}</style>

      <div style={{ width: '100%', maxWidth: 420 }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ ...headline, fontSize: 30, letterSpacing: 0.5 }}>딥 씨 크루</div>
          <div style={{ color: '#7FA6C2', fontSize: 13, marginTop: 4 }}>협동 트릭테이킹 · 미션 레벨전</div>
        </div>

        {screen === 'join' && (
          <div style={{ background: '#103552', borderRadius: 16, padding: 22, border: '1px solid rgba(255,255,255,0.08)' }}>
            <label style={{ fontSize: 13, color: '#7FA6C2' }}>이름</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="닉네임"
              style={{ width: '100%', marginTop: 6, marginBottom: 18, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: '#0B2A45', color: '#EAF6F6', outline: 'none' }}
            />
            <button onClick={handleCreate} disabled={busy} style={{ width: '100%', padding: 12, borderRadius: 10, border: 'none', background: '#2FE6C7', color: '#05121F', fontWeight: 700, fontSize: 15, marginBottom: 18, cursor: 'pointer' }}>
              새 방 만들기
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#4A6E85', fontSize: 12, marginBottom: 18 }}>
              <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.1)' }} />
              또는
              <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.1)' }} />
            </div>
            <label style={{ fontSize: 13, color: '#7FA6C2' }}>방 코드로 참가</label>
            <input
              value={roomCodeInput}
              onChange={(e) => setRoomCodeInput(e.target.value)}
              placeholder="4자리 코드"
              style={{ width: '100%', marginTop: 6, marginBottom: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: '#0B2A45', color: '#EAF6F6', outline: 'none' }}
            />
            <button onClick={handleJoin} disabled={busy} style={{ width: '100%', padding: 12, borderRadius: 10, border: '1px solid #2FE6C7', background: 'transparent', color: '#2FE6C7', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>
              참가하기
            </button>
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
                  <span>{p.name}{p.id === myId ? ' (나)' : ''}</span>
                </div>
              ))}
            </div>
            {isHost ? (
              <button
                onClick={() => startMission(room.missionLevel || 1)}
                disabled={busy || room.players.length < 2}
                style={{ width: '100%', padding: 12, borderRadius: 10, border: 'none', background: room.players.length < 2 ? '#284A5E' : '#2FE6C7', color: room.players.length < 2 ? '#7FA6C2' : '#05121F', fontWeight: 700, fontSize: 15, cursor: room.players.length < 2 ? 'default' : 'pointer' }}
              >
                {room.players.length < 2 ? '2명 이상 모이면 시작 가능' : `레벨 ${room.missionLevel || 1} 미션 시작 (${room.players.length}명)`}
              </button>
            ) : (
              <div style={{ textAlign: 'center', padding: 12, borderRadius: 10, background: 'rgba(255,255,255,0.04)', color: '#7FA6C2', fontSize: 14 }}>
                방장({room.players[0]?.name})님이 시작하길 기다리는 중...
              </div>
            )}
          </div>
        )}

        {screen === 'game' && room && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#7FA6C2', marginBottom: 6 }}>
              <span>레벨 {room.missionLevel || 1} · 트릭 {room.trickNumber}</span>
              <span>방 {roomCode}</span>
            </div>
            {room.captainId && (
              <div style={{ textAlign: 'center', fontSize: 11, color: '#4A6E85', marginBottom: 12 }}>
                ⚓ 캡틴: {playerName(room, room.captainId)} (첫 트릭을 리드해요)
              </div>
            )}

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: '#7FA6C2', marginBottom: 8 }}>이번 미션 목표 - 이 카드로 트릭을 이겨야 해요</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {roomTargetCards.map((tc) => <TaskBadge key={tc.id} tc={tc} />)}
              </div>
            </div>

            {missionActive && (
              <div style={{ textAlign: 'center', marginBottom: 16, padding: 10, borderRadius: 10, background: myTurn ? 'rgba(47,230,199,0.12)' : 'rgba(255,255,255,0.04)', color: myTurn ? '#2FE6C7' : '#7FA6C2', fontSize: 14, fontWeight: 600 }}>
                {room.trickResult ? '트릭 결과 확인' : myTurn ? '지금 당신의 차례예요' : `${playerName(room, roomTurnOrder[room.turnIndex])}님의 차례`}
              </div>
            )}

            <div style={{ background: '#103552', borderRadius: 16, padding: 18, minHeight: 120, marginBottom: 18, border: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ fontSize: 12, color: '#7FA6C2', marginBottom: 10 }}>{!missionActive ? '마지막 트릭' : '현재 트릭'}</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {(room.trickResult ? room.trickResult.cards : roomTrick).map((t) => (
                  <div key={t.playerId} style={{ textAlign: 'center' }}>
                    <CardView card={t.card} disabled />
                    <div style={{ fontSize: 11, color: '#7FA6C2', marginTop: 4 }}>{playerName(room, t.playerId)}</div>
                  </div>
                ))}
                {roomTrick.length === 0 && !room.trickResult && missionActive && (
                  <div style={{ color: '#4A6E85', fontSize: 13 }}>아직 낸 카드가 없어요</div>
                )}
              </div>
            </div>

            {room.trickResult && missionActive && (
              <div style={{ textAlign: 'center', marginBottom: 18 }}>
                <div style={{ color: '#2FE6C7', fontWeight: 700, marginBottom: 10 }}>
                  {playerName(room, room.trickResult.winnerId)}님이 트릭을 가져갔어요
                </div>
                <button onClick={nextTrick} disabled={busy} style={{ padding: '10px 22px', borderRadius: 10, border: 'none', background: '#2FE6C7', color: '#05121F', fontWeight: 700, cursor: 'pointer' }}>
                  다음 트릭
                </button>
              </div>
            )}

            {room.missionStatus === 'success' && (
              <div style={{ background: 'rgba(47,230,199,0.1)', borderRadius: 16, padding: 20, border: '1px solid rgba(47,230,199,0.3)', marginBottom: 18, textAlign: 'center' }}>
                <div style={{ ...headline, fontSize: 20, marginBottom: 10, color: '#2FE6C7' }}>🎉 레벨 {room.missionLevel} 미션 성공!</div>
                {isHost ? (
                  <button onClick={() => startMission((room.missionLevel || 1) + 1)} disabled={busy} style={{ padding: '10px 22px', borderRadius: 10, border: 'none', background: '#2FE6C7', color: '#05121F', fontWeight: 700, cursor: 'pointer' }}>
                    다음 미션 (레벨 {(room.missionLevel || 1) + 1}) 시작
                  </button>
                ) : (
                  <div style={{ color: '#7FA6C2', fontSize: 13 }}>방장이 다음 미션을 시작하길 기다리는 중...</div>
                )}
              </div>
            )}

            {room.missionStatus === 'failed' && (
              <div style={{ background: 'rgba(255,111,165,0.1)', borderRadius: 16, padding: 20, border: '1px solid rgba(255,111,165,0.3)', marginBottom: 18, textAlign: 'center' }}>
                <div style={{ ...headline, fontSize: 20, marginBottom: 10, color: '#FF6FA5' }}>미션 실패 - 레벨 {room.missionLevel}</div>
                {isHost ? (
                  <button onClick={() => startMission(room.missionLevel || 1)} disabled={busy} style={{ padding: '10px 22px', borderRadius: 10, border: 'none', background: '#FF6FA5', color: '#05121F', fontWeight: 700, cursor: 'pointer' }}>
                    같은 레벨 다시 도전
                  </button>
                ) : (
                  <div style={{ color: '#7FA6C2', fontSize: 13 }}>방장이 재도전을 시작하길 기다리는 중...</div>
                )}
              </div>
            )}

            {missionActive && (
              <div>
                <div style={{ fontSize: 12, color: '#7FA6C2', marginBottom: 8 }}>내 손패 ({myHand.length}장) · 금색 테두리는 내 목표 카드예요</div>
                <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8 }}>
                  {myHand.map((card) => (
                    <CardView
                      key={card.id}
                      card={card}
                      size="lg"
                      highlighted={roomTargetCards.some((tc) => tc.id === card.id && tc.status === 'pending')}
                      disabled={!myTurn || !!room.trickResult || !canPlay(card)}
                      onClick={() => playCard(card)}
                    />
                  ))}
                </div>
                {ledSuit && !room.trickResult && (
                  <div style={{ fontSize: 12, color: '#4A6E85', marginTop: 8 }}>
                    이번 트릭 리드 수트: {SUIT_INFO[ledSuit].label} (가능하면 같은 수트를 내야 해요)
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
