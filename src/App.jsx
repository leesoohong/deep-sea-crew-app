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
  SUBMARINE: { label: '잠수함', color: '#F0B84B' },
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

// room 저장 형태: { code, hostId, numPlayers, started, members: {playerId: {name, seat}}, game: <Game.toJSON()> }

function loadGame(room) {
  if (!room || !room.game) return null;
  try { return Game.fromJSON(room.game); } catch (e) { return null; }
}

function CardChip({ card, disabled, onClick, size = 'md', dim }) {
  const info = SUIT_INFO[card.suit];
  const dims = size === 'lg' ? { w: 50, h: 70, fs: 20 } : { w: 40, h: 56, fs: 16 };
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        width: dims.w, height: dims.h, borderRadius: 9,
        border: `2px solid ${info.color}`,
        background: card.suit === 'SUBMARINE' ? '#161C24' : `${info.color}1A`,
        color: info.color, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        opacity: dim ? 0.4 : 1, flexShrink: 0,
        cursor: (disabled || !onClick) ? 'default' : 'pointer', fontFamily: "'Space Grotesk', sans-serif",
      }}>
      <span style={{ fontSize: dims.fs, fontWeight: 700, lineHeight: 1 }}>{card.value}</span>
      <span style={{ fontSize: 8, marginTop: 2 }}>{info.label}</span>
    </button>
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
  const [room, setRoom] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [predictInput, setPredictInput] = useState('');

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

  useEffect(() => {
    if (room && room.started && screen === 'lobby') setScreen('game');
  }, [room, screen]);

  // ---------- 로비 액션 ----------
  const handleCreate = async () => {
    if (!name.trim()) { setError('이름을 입력해주세요'); return; }
    setError('');
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    const room0 = {
      code, hostId: myId, numPlayers: numPlayersInput, started: false,
      members: { [myId]: { name: name.trim(), seat: 0 } },
      game: null,
    };
    setBusy(true);
    await writeRoom(code, room0);
    setBusy(false);
    setRoomCode(code); setRoom(room0); setScreen('lobby');
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

    const g = new Game(r.numPlayers, { rescueSignalEnabled: true });
    Object.entries(members).forEach(([pid, m]) => g.assignSeat(m.seat, pid, m.name));
    // 캠페인 1번 미션부터 시작
    const difficulty = CAMPAIGN_MISSIONS[0];
    g.startMission(1, difficulty);
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
  const doNextMission = () => mutate((g) => {
    const next = g.missionNumber + 1;
    const diff = CAMPAIGN_MISSIONS[Math.min(next - 1, CAMPAIGN_MISSIONS.length - 1)];
    g.startMission(next, diff);
  });
  const doRetry = () => mutate((g) => g.retryMission());
  const doRescueDir = (dir) => mutate((g) => g.rescueChooseDirection(mySeatOf(g), dir));
  const doRescuePass = (willPass) => mutate((g) => g.rescueChoosePassOrNot(mySeatOf(g), willPass));
  const doRescueCard = (card) => mutate((g) => g.rescueChooseCard(mySeatOf(g), card));
  const doPredict = (taskId, value) => mutate((g) => g.submitPrediction(mySeatOf(g), taskId, value));

  function mySeatOf(g) { return g.seatOfPlayer(myId); }

  const pageStyle = {
    minHeight: '100vh',
    background: 'radial-gradient(ellipse at 50% -10%, #123650 0%, #05121F 60%)',
    color: '#EAF6F6', fontFamily: "'Space Grotesk', sans-serif",
  };
  const headline = { fontFamily: "'Fraunces', serif", fontWeight: 600 };
  const fontStyle = `@import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@500;600&family=Space+Grotesk:wght@400;500;700&display=swap'); *{box-sizing:border-box;} body{margin:0;}`;

  if (!authReady || !myId) {
    return <div style={{ ...pageStyle, display: 'flex', justifyContent: 'center' }}><div style={{ marginTop: 100, color: '#7FA6C2' }}>연결 중...</div></div>;
  }

  // ============ JOIN / LOBBY ============
  if (screen !== 'game' || !room || !room.started) {
    return (
      <div style={{ ...pageStyle, padding: '24px 16px 40px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <style>{fontStyle}</style>
        <div style={{ width: '100%', maxWidth: 440 }}>
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <div style={{ ...headline, fontSize: 30, letterSpacing: 0.5 }}>딥 씨 크루</div>
            <div style={{ color: '#7FA6C2', fontSize: 13, marginTop: 4 }}>협동 트릭테이킹 · 캠페인</div>
          </div>

          {screen === 'join' && (
            <div style={{ background: '#103552', borderRadius: 16, padding: 22, border: '1px solid rgba(255,255,255,0.08)' }}>
              <label style={{ fontSize: 13, color: '#7FA6C2' }}>이름</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="닉네임"
                style={{ width: '100%', marginTop: 6, marginBottom: 16, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: '#0B2A45', color: '#EAF6F6', outline: 'none' }} />
              <label style={{ fontSize: 13, color: '#7FA6C2' }}>인원 수 (새 방 만들 때)</label>
              <div style={{ display: 'flex', gap: 8, marginTop: 6, marginBottom: 16 }}>
                {[3, 4, 5].map((n) => (
                  <button key={n} onClick={() => setNumPlayersInput(n)}
                    style={{ flex: 1, padding: 10, borderRadius: 10, border: numPlayersInput === n ? '2px solid #2FE6C7' : '1px solid rgba(255,255,255,0.15)', background: numPlayersInput === n ? 'rgba(47,230,199,0.12)' : '#0B2A45', color: numPlayersInput === n ? '#2FE6C7' : '#EAF6F6', fontWeight: 700, cursor: 'pointer' }}>
                    {n}명
                  </button>
                ))}
              </div>
              <button onClick={handleCreate} disabled={busy} style={{ width: '100%', padding: 12, borderRadius: 10, border: 'none', background: '#2FE6C7', color: '#05121F', fontWeight: 700, fontSize: 15, marginBottom: 18, cursor: 'pointer' }}>새 방 만들기</button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#4A6E85', fontSize: 12, marginBottom: 16 }}>
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
              <div style={{ textAlign: 'center', marginBottom: 18 }}>
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

  const commUsed = view.comm[seat] && view.comm[seat].used;
  const canCommunicateNow = phase === 'playing' && curTrick && curTrick.plays.length === 0 && !commUsed && !view.missionModifiers.noCommunication;

  return (
    <div style={{ ...pageStyle, display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <style>{fontStyle}</style>

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 14px 10px' }}>
        <div style={{ width: '100%', maxWidth: 480, margin: '0 auto' }}>
          {/* 헤더 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#7FA6C2', marginBottom: 4 }}>
            <span>임무 {view.missionNumber} · 난이도 {view.missionDifficulty}</span>
            <span>방 {roomCode}</span>
          </div>
          <div style={{ textAlign: 'center', fontSize: 11, color: '#4A6E85', marginBottom: 10 }}>
            ⚓ 선장: {captainName}{view.attemptNumber > 1 ? ` · ${view.attemptNumber}번째 시도` : ''}
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

          {/* 구조신호 단계 */}
          {phase === 'rescueSignal' && view.rescue && (
            <div style={{ background: '#103552', borderRadius: 14, padding: 16, marginBottom: 12, border: '1px solid rgba(76,141,255,0.3)' }}>
              <div style={{ ...headline, fontSize: 16, color: '#4C8DFF', marginBottom: 8 }}>🆘 구조신호</div>
              {view.rescue.step === 'direction' && (
                <>
                  <div style={{ fontSize: 12, color: '#7FA6C2', marginBottom: 10 }}>카드를 전달할 방향을 정하세요 (전원 같은 방향이어야 진행). 원치 않으면 다음 단계에서 전달 안 함을 고르면 돼요.</div>
                  {view.rescue.directionChoice[seat] ? (
                    <div style={{ textAlign: 'center', color: '#4A6E85', fontSize: 13 }}>선택함: {view.rescue.directionChoice[seat] === 'left' ? '왼쪽' : '오른쪽'} · 다른 인원 대기 중</div>
                  ) : (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => doRescueDir('left')} disabled={busy} style={{ flex: 1, padding: 10, borderRadius: 10, border: '1px solid #4C8DFF', background: 'transparent', color: '#4C8DFF', fontWeight: 700, cursor: 'pointer' }}>왼쪽</button>
                      <button onClick={() => doRescueDir('right')} disabled={busy} style={{ flex: 1, padding: 10, borderRadius: 10, border: '1px solid #4C8DFF', background: 'transparent', color: '#4C8DFF', fontWeight: 700, cursor: 'pointer' }}>오른쪽</button>
                    </div>
                  )}
                </>
              )}
              {view.rescue.step === 'passOrNot' && (
                <>
                  <div style={{ fontSize: 12, color: '#7FA6C2', marginBottom: 10 }}>카드를 전달할까요? (전원 일치해야 함)</div>
                  {view.rescue.passChoice[seat] !== undefined ? (
                    <div style={{ textAlign: 'center', color: '#4A6E85', fontSize: 13 }}>선택함 · 다른 인원 대기 중</div>
                  ) : (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => doRescuePass(true)} disabled={busy} style={{ flex: 1, padding: 10, borderRadius: 10, border: '1px solid #2FE6C7', background: 'transparent', color: '#2FE6C7', fontWeight: 700, cursor: 'pointer' }}>전달함</button>
                      <button onClick={() => doRescuePass(false)} disabled={busy} style={{ flex: 1, padding: 10, borderRadius: 10, border: '1px solid #7FA6C2', background: 'transparent', color: '#7FA6C2', fontWeight: 700, cursor: 'pointer' }}>전달 안 함</button>
                    </div>
                  )}
                </>
              )}
              {view.rescue.step === 'chooseCard' && (
                <div style={{ fontSize: 12, color: '#7FA6C2' }}>아래 손패에서 이웃에게 넘길 카드를 고르세요 (잠수함 제외).</div>
              )}
            </div>
          )}

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

          {/* 진행 안내 */}
          {phase === 'playing' && (
            <div style={{ textAlign: 'center', marginBottom: 10, padding: 10, borderRadius: 10, background: isMyTurn ? 'rgba(47,230,199,0.12)' : 'rgba(255,255,255,0.04)', color: isMyTurn ? '#2FE6C7' : '#7FA6C2', fontSize: 14, fontWeight: 600 }}>
              {isMyTurn ? '지금 당신의 차례예요' : `${seatName(toAct)}님의 차례`}
            </div>
          )}

          {/* 현재 트릭 */}
          {(phase === 'playing' || phase === 'missionEnd') && (
            <div style={{ background: '#103552', borderRadius: 16, padding: 14, minHeight: 96, marginBottom: 10, border: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ fontSize: 12, color: '#7FA6C2', marginBottom: 8 }}>
                {curTrick ? `트릭 ${curTrick.trickIndex}` : (view.previousTrick ? `지난 트릭 ${view.previousTrick.trickIndex}` : '트릭')}
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {(curTrick && curTrick.plays.length > 0 ? curTrick.plays : (view.previousTrick ? view.previousTrick.plays : [])).map((p) => (
                  <div key={p.seat} style={{ textAlign: 'center' }}>
                    <CardChip card={p.card} disabled />
                    <div style={{ fontSize: 11, color: '#7FA6C2', marginTop: 4 }}>{seatName(p.seat)}</div>
                  </div>
                ))}
                {(!curTrick || curTrick.plays.length === 0) && !view.previousTrick && <div style={{ color: '#4A6E85', fontSize: 13 }}>아직 낸 카드가 없어요</div>}
              </div>
            </div>
          )}

          {/* 통신 정보 (다른 사람이 통신한 카드 표시) */}
          {Object.entries(view.comm || {}).filter(([s, c]) => c && c.active).length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: '#7FA6C2', marginBottom: 6 }}>📡 통신됨</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {Object.entries(view.comm).filter(([s, c]) => c && c.active).map(([s, c]) => (
                  <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#7FA6C2' }}>
                    <CardChip card={c.card} disabled />
                    <span>{seatName(Number(s))}<br/>{c.position === 'HIGHEST' ? '최고' : c.position === 'LOWEST' ? '최저' : '유일'}</span>
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
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', background: '#0A2438', padding: '10px 14px 14px', maxHeight: '44vh', overflowY: 'auto' }}>
        <div style={{ width: '100%', maxWidth: 480, margin: '0 auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#7FA6C2', marginBottom: 6 }}>
            <span>내 손패 ({myHand.length}장){myTasks.length > 0 ? ` · 내 과제 ${myTasks.length}개` : ''}</span>
            {canCommunicateNow && <span style={{ color: '#F0B84B' }}>카드를 길게 눌러 통신 (아래 통신 버튼)</span>}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {myHand.map((card) => {
              const cid = `${card.suit}${card.value}`;
              // 구조신호 카드 선택 단계
              if (phase === 'rescueSignal' && view.rescue && view.rescue.step === 'chooseCard') {
                const givable = card.suit !== 'SUBMARINE';
                return <CardChip key={cid} card={card} size="lg" dim={!givable} onClick={givable ? () => doRescueCard(card) : undefined} />;
              }
              const playable = isMyTurn && legalIds.has(cid);
              return <CardChip key={cid} card={card} size="lg" dim={phase === 'playing' && !playable} onClick={playable ? () => doPlayCard(card) : undefined} />;
            })}
          </div>

          {/* 통신 버튼 */}
          {canCommunicateNow && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: '#7FA6C2', marginBottom: 6 }}>📡 통신할 카드 선택 (최고/최저/유일인 색깔 카드만 가능, 임무당 1회)</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {myHand.filter((c) => c.suit !== 'SUBMARINE').map((card) => {
                  const cid = `comm-${card.suit}${card.value}`;
                  return <CardChip key={cid} card={card} onClick={() => doCommunicate(card)} />;
                })}
              </div>
            </div>
          )}

          {error && <div style={{ color: '#FF6FA5', fontSize: 12, marginTop: 8 }}>{error}</div>}
        </div>
      </div>
    </div>
  );
}
