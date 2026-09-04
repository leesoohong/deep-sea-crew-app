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

// ==========================================================================
// 미션(태스크) 정의
// 각 태스크는 판정 함수를 가진다. evaluate(ctx) -> 'success' | 'failed' | 'pending'
// ctx: { ownerId, wonTricks: {playerId: [ {cards, trickNumber} ...] },
//        allTricks: [ {winnerId, cards, trickNumber} ], totalTricks, done(모든 트릭 끝) }
// wonTricks[pid] = 그 사람이 이긴 트릭들의 배열. 각 트릭엔 cards(플레이된 카드들)와 trickNumber.
// ==========================================================================

function cardsOfOwner(ctx) {
  // 소유자가 이긴 모든 카드(트릭 안 카드 전부)
  const tricks = ctx.wonTricks[ctx.ownerId] || [];
  return tricks.flatMap((t) => t.cards.map((c) => c.card));
}
function ownerTrickCount(ctx) {
  return (ctx.wonTricks[ctx.ownerId] || []).length;
}
function trickHasCard(trick, pred) {
  return trick.cards.some((c) => pred(c.card));
}

// 태스크 카탈로그. point = 난이도(점수)
const TASK_CATALOG = [
  // ---------- 1점 ----------
  ...SUITS.map((s) => ({
    key: `low-${s}`, point: 1,
    label: `${SUIT_INFO[s].label} 1·2·3 중 1장 든 트릭 따기`,
    evaluate: (ctx) => {
      const won = (ctx.wonTricks[ctx.ownerId] || []).some((t) => trickHasCard(t, (c) => c.suit === s && c.num <= 3));
      if (won) return 'success';
      return ctx.done ? 'failed' : 'pending';
    },
  })),
  ...SUITS.map((s) => ({
    key: `high-${s}`, point: 1,
    label: `${SUIT_INFO[s].label} 7·8·9 중 1장 든 트릭 따기`,
    evaluate: (ctx) => {
      const won = (ctx.wonTricks[ctx.ownerId] || []).some((t) => trickHasCard(t, (c) => c.suit === s && c.num >= 7));
      if (won) return 'success';
      return ctx.done ? 'failed' : 'pending';
    },
  })),
  { key: 'get-1', point: 1, label: '숫자 1 카드 1장 이상 따기',
    evaluate: (ctx) => { const has = cardsOfOwner(ctx).some((c) => c.num === 1); return has ? 'success' : (ctx.done ? 'failed' : 'pending'); } },
  { key: 'get-9', point: 1, label: '숫자 9 카드 1장 이상 따기',
    evaluate: (ctx) => { const has = cardsOfOwner(ctx).some((c) => c.num === 9); return has ? 'success' : (ctx.done ? 'failed' : 'pending'); } },
  { key: 'get-sub', point: 1, label: '잠수함 카드 1장 이상 따기',
    evaluate: (ctx) => { const has = cardsOfOwner(ctx).some((c) => c.suit === 'black'); return has ? 'success' : (ctx.done ? 'failed' : 'pending'); } },
  { key: 'even-trick', point: 1, label: '짝수 카드로만 구성된 트릭 따기',
    evaluate: (ctx) => { const won = (ctx.wonTricks[ctx.ownerId] || []).some((t) => t.cards.every((c) => c.card.num % 2 === 0)); return won ? 'success' : (ctx.done ? 'failed' : 'pending'); } },
  { key: 'odd-trick', point: 1, label: '홀수 카드로만 구성된 트릭 따기',
    evaluate: (ctx) => { const won = (ctx.wonTricks[ctx.ownerId] || []).some((t) => t.cards.every((c) => c.card.num % 2 === 1)); return won ? 'success' : (ctx.done ? 'failed' : 'pending'); } },
  { key: 'sum-ge-15', point: 1, label: '숫자 합 15 이상인 트릭 따기',
    evaluate: (ctx) => { const won = (ctx.wonTricks[ctx.ownerId] || []).some((t) => t.cards.reduce((s, c) => s + c.card.num, 0) >= 15); return won ? 'success' : (ctx.done ? 'failed' : 'pending'); } },
  { key: 'sum-le-10', point: 1, label: '숫자 합 10 이하인 트릭 따기',
    evaluate: (ctx) => { const won = (ctx.wonTricks[ctx.ownerId] || []).some((t) => t.cards.reduce((s, c) => s + c.card.num, 0) <= 10); return won ? 'success' : (ctx.done ? 'failed' : 'pending'); } },
  { key: 'exactly-1', point: 1, label: '트릭을 정확히 1개만 따기',
    evaluate: (ctx) => { const n = ownerTrickCount(ctx); if (n > 1) return 'failed'; return ctx.done ? (n === 1 ? 'success' : 'failed') : 'pending'; } },
  { key: 'exactly-2', point: 1, label: '트릭을 정확히 2개만 따기',
    evaluate: (ctx) => { const n = ownerTrickCount(ctx); if (n > 2) return 'failed'; return ctx.done ? (n === 2 ? 'success' : 'failed') : 'pending'; } },
  { key: 'win-1st', point: 1, label: '첫 번째 트릭 따기',
    evaluate: (ctx) => { const t1 = ctx.allTricks.find((t) => t.trickNumber === 1); if (!t1) return 'pending'; return t1.winnerId === ctx.ownerId ? 'success' : 'failed'; } },
  { key: 'win-2nd', point: 1, label: '두 번째 트릭 따기',
    evaluate: (ctx) => { const t = ctx.allTricks.find((t) => t.trickNumber === 2); if (!t) return 'pending'; return t.winnerId === ctx.ownerId ? 'success' : 'failed'; } },
  { key: 'win-3rd', point: 1, label: '세 번째 트릭 따기',
    evaluate: (ctx) => { const t = ctx.allTricks.find((t) => t.trickNumber === 3); if (!t) return 'pending'; return t.winnerId === ctx.ownerId ? 'success' : 'failed'; } },

  // ---------- 2점 ----------
  ...SUITS.map((s) => ({
    key: `three-${s}`, point: 2,
    label: `한 트릭에서 ${SUIT_INFO[s].label} 카드 3장 이상 따기`,
    evaluate: (ctx) => {
      const won = (ctx.wonTricks[ctx.ownerId] || []).some((t) => t.cards.filter((c) => c.card.suit === s).length >= 3);
      return won ? 'success' : (ctx.done ? 'failed' : 'pending');
    },
  })),
  { key: 'three-colors', point: 2, label: '서로 다른 색 3가지 이상 든 트릭 따기',
    evaluate: (ctx) => { const won = (ctx.wonTricks[ctx.ownerId] || []).some((t) => new Set(t.cards.map((c) => c.card.suit).filter((x) => x !== 'black')).size >= 3); return won ? 'success' : (ctx.done ? 'failed' : 'pending'); } },
  { key: 'same-number-2', point: 2, label: '같은 숫자 2장 든 트릭 따기',
    evaluate: (ctx) => { const won = (ctx.wonTricks[ctx.ownerId] || []).some((t) => { const nums = t.cards.map((c) => c.card.num); return nums.some((n, i) => nums.indexOf(n) !== i); }); return won ? 'success' : (ctx.done ? 'failed' : 'pending'); } },
  { key: 'exactly-3', point: 2, label: '트릭을 정확히 3개 따기',
    evaluate: (ctx) => { const n = ownerTrickCount(ctx); if (n > 3) return 'failed'; return ctx.done ? (n === 3 ? 'success' : 'failed') : 'pending'; } },
  { key: 'exactly-4', point: 2, label: '트릭을 정확히 4개 따기',
    evaluate: (ctx) => { const n = ownerTrickCount(ctx); if (n > 4) return 'failed'; return ctx.done ? (n === 4 ? 'success' : 'failed') : 'pending'; } },
  { key: 'zero-tricks', point: 2, label: '트릭을 하나도 따지 않기',
    evaluate: (ctx) => { const n = ownerTrickCount(ctx); if (n > 0) return 'failed'; return ctx.done ? 'success' : 'pending'; } },
  { key: 'most-tricks', point: 2, label: '모든 사람 중 가장 많은 트릭 따기',
    evaluate: (ctx) => { if (!ctx.done) return 'pending'; const mine = ownerTrickCount(ctx); const max = Math.max(...ctx.turnOrder.map((pid) => (ctx.wonTricks[pid] || []).length)); const uniqueMax = ctx.turnOrder.filter((pid) => (ctx.wonTricks[pid] || []).length === max).length === 1; return (mine === max && uniqueMax) ? 'success' : 'failed'; } },
  { key: 'fewest-tricks', point: 2, label: '가장 적은 트릭 따기 (최소 1개)',
    evaluate: (ctx) => { if (!ctx.done) return 'pending'; const mine = ownerTrickCount(ctx); if (mine < 1) return 'failed'; const min = Math.min(...ctx.turnOrder.map((pid) => (ctx.wonTricks[pid] || []).length)); const uniqueMin = ctx.turnOrder.filter((pid) => (ctx.wonTricks[pid] || []).length === min).length === 1; return (mine === min && uniqueMin) ? 'success' : 'failed'; } },
  { key: 'win-first-2', point: 2, label: '첫 2개 트릭 중 하나 따기',
    evaluate: (ctx) => { const first2 = ctx.allTricks.filter((t) => t.trickNumber <= 2); const won = first2.some((t) => t.winnerId === ctx.ownerId); if (won) return 'success'; return (ctx.allTricks.some((t) => t.trickNumber === 2)) ? 'failed' : 'pending'; } },
  { key: 'win-last', point: 2, label: '마지막 트릭 따기',
    evaluate: (ctx) => { if (!ctx.done) return 'pending'; const last = ctx.allTricks.reduce((a, b) => (a.trickNumber > b.trickNumber ? a : b), ctx.allTricks[0]); return last && last.winnerId === ctx.ownerId ? 'success' : 'failed'; } },
  { key: 'get-5', point: 2, label: '숫자 5 든 트릭 따기',
    evaluate: (ctx) => { const won = (ctx.wonTricks[ctx.ownerId] || []).some((t) => trickHasCard(t, (c) => c.num === 5)); return won ? 'success' : (ctx.done ? 'failed' : 'pending'); } },
  { key: 'get-1-and-9', point: 2, label: '같은 트릭에서 1과 9 함께 따기',
    evaluate: (ctx) => { const won = (ctx.wonTricks[ctx.ownerId] || []).some((t) => trickHasCard(t, (c) => c.num === 1) && trickHasCard(t, (c) => c.num === 9)); return won ? 'success' : (ctx.done ? 'failed' : 'pending'); } },
  { key: 'two-subs-trick', point: 2, label: '잠수함 2장 이상 든 트릭 따기',
    evaluate: (ctx) => { const won = (ctx.wonTricks[ctx.ownerId] || []).some((t) => t.cards.filter((c) => c.card.suit === 'black').length >= 2); return won ? 'success' : (ctx.done ? 'failed' : 'pending'); } },

  // ---------- 3점 ----------
  { key: 'four-colors', point: 3, label: '네 가지 색이 모두 든 트릭 따기',
    evaluate: (ctx) => { const won = (ctx.wonTricks[ctx.ownerId] || []).some((t) => SUITS.every((s) => t.cards.some((c) => c.card.suit === s))); return won ? 'success' : (ctx.done ? 'failed' : 'pending'); } },
  { key: 'sum-ge-22', point: 3, label: '숫자 합 22 이상인 트릭 따기',
    evaluate: (ctx) => { const won = (ctx.wonTricks[ctx.ownerId] || []).some((t) => t.cards.reduce((s, c) => s + c.card.num, 0) >= 22); return won ? 'success' : (ctx.done ? 'failed' : 'pending'); } },
  { key: 'sum-le-8', point: 3, label: '숫자 합 8 이하인 트릭 따기',
    evaluate: (ctx) => { const won = (ctx.wonTricks[ctx.ownerId] || []).some((t) => t.cards.reduce((s, c) => s + c.card.num, 0) <= 8); return won ? 'success' : (ctx.done ? 'failed' : 'pending'); } },
  { key: 'sub4-trick', point: 3, label: '잠수함 4번이 든 트릭 따기',
    evaluate: (ctx) => { const won = (ctx.wonTricks[ctx.ownerId] || []).some((t) => trickHasCard(t, (c) => c.suit === 'black' && c.num === 4)); return won ? 'success' : (ctx.done ? 'failed' : 'pending'); } },
  ...SUITS.map((s) => ({
    key: `avoid-${s}`, point: 3,
    label: `${SUIT_INFO[s].label} 카드를 한 장도 따지 않기`,
    evaluate: (ctx) => { const got = cardsOfOwner(ctx).some((c) => c.suit === s); if (got) return 'failed'; return ctx.done ? 'success' : 'pending'; },
  })),
  { key: 'avoid-sub', point: 3, label: '잠수함 카드를 한 장도 따지 않기',
    evaluate: (ctx) => { const got = cardsOfOwner(ctx).some((c) => c.suit === 'black'); if (got) return 'failed'; return ctx.done ? 'success' : 'pending'; } },
  { key: 'avoid-9', point: 3, label: '숫자 9 카드를 한 장도 따지 않기',
    evaluate: (ctx) => { const got = cardsOfOwner(ctx).some((c) => c.num === 9); if (got) return 'failed'; return ctx.done ? 'success' : 'pending'; } },
  { key: 'win-first-and-last', point: 3, label: '첫 트릭과 마지막 트릭을 모두 따기',
    evaluate: (ctx) => {
      const t1 = ctx.allTricks.find((t) => t.trickNumber === 1);
      if (t1 && t1.winnerId !== ctx.ownerId) return 'failed';
      if (!ctx.done) return 'pending';
      const last = ctx.allTricks.reduce((a, b) => (a.trickNumber > b.trickNumber ? a : b), ctx.allTricks[0]);
      return (t1 && t1.winnerId === ctx.ownerId && last && last.winnerId === ctx.ownerId) ? 'success' : 'failed';
    } },
  { key: 'exactly-5', point: 3, label: '트릭을 정확히 5개 따기',
    evaluate: (ctx) => { const n = ownerTrickCount(ctx); if (n > 5) return 'failed'; return ctx.done ? (n === 5 ? 'success' : 'failed') : 'pending'; } },

  // ---------- 4점 ----------
  { key: 'sum-ge-25', point: 4, label: '숫자 합 25 이상인 트릭 따기',
    evaluate: (ctx) => { const won = (ctx.wonTricks[ctx.ownerId] || []).some((t) => t.cards.reduce((s, c) => s + c.card.num, 0) >= 25); return won ? 'success' : (ctx.done ? 'failed' : 'pending'); } },
  { key: 'sum-le-5', point: 4, label: '숫자 합 5 이하인 트릭 따기',
    evaluate: (ctx) => { const won = (ctx.wonTricks[ctx.ownerId] || []).some((t) => t.cards.reduce((s, c) => s + c.card.num, 0) <= 5); return won ? 'success' : (ctx.done ? 'failed' : 'pending'); } },
  { key: 'all-subs-trick', point: 4, label: '잠수함 1·2·3·4가 모두 든 트릭 따기',
    evaluate: (ctx) => { const won = (ctx.wonTricks[ctx.ownerId] || []).some((t) => [1, 2, 3, 4].every((n) => t.cards.some((c) => c.card.suit === 'black' && c.card.num === n))); return won ? 'success' : (ctx.done ? 'failed' : 'pending'); } },
  { key: 'six-plus', point: 4, label: '트릭을 6개 이상 따기',
    evaluate: (ctx) => { const n = ownerTrickCount(ctx); if (n >= 6) return 'success'; return ctx.done ? 'failed' : 'pending'; } },
  { key: 'get-two-1-two-9', point: 4, label: '한 트릭에서 1 두 장과 9 두 장 모두 따기',
    evaluate: (ctx) => { const won = (ctx.wonTricks[ctx.ownerId] || []).some((t) => t.cards.filter((c) => c.card.num === 1).length >= 2 && t.cards.filter((c) => c.card.num === 9).length >= 2); return won ? 'success' : (ctx.done ? 'failed' : 'pending'); } },
];

const TASK_MAP = Object.fromEntries(TASK_CATALOG.map((t) => [t.key, t]));

// 레벨(난이도 점수) → 태스크 뽑기. 총점이 레벨과 같아지도록 태스크를 뽑는다.
function drawTasksForLevel(level) {
  const targetPoints = level;
  const pool = shuffle(TASK_CATALOG);
  const chosen = [];
  let sum = 0;
  for (const t of pool) {
    if (sum + t.point <= targetPoints) {
      chosen.push({ key: t.key, ownerId: null, status: 'pending' });
      sum += t.point;
    }
    if (sum === targetPoints) break;
  }
  // 목표점수를 정확히 못 채우면 1점짜리로 메꿈
  if (sum < targetPoints) {
    const ones = shuffle(TASK_CATALOG.filter((t) => t.point === 1));
    for (const t of ones) {
      if (sum >= targetPoints) break;
      chosen.push({ key: t.key, ownerId: null, status: 'pending' });
      sum += 1;
    }
  }
  return chosen;
}

// ==========================================================================
// 트릭 판정
// ==========================================================================
function resolveTrickWinner(trickCards) {
  const leadSuit = trickCards[0].card.suit;
  const blacks = trickCards.filter((t) => t.card.suit === 'black');
  if (blacks.length > 0) return blacks.reduce((a, b) => (a.card.num > b.card.num ? a : b));
  const led = trickCards.filter((t) => t.card.suit === leadSuit);
  return led.reduce((a, b) => (a.card.num > b.card.num ? a : b));
}

// 태스크 전체 재판정
function evaluateAllTasks(state) {
  const allTricks = state.history || []; // {winnerId, cards, trickNumber}
  const wonTricks = {};
  (state.turnOrder || []).forEach((pid) => (wonTricks[pid] = []));
  allTricks.forEach((t) => {
    if (!wonTricks[t.winnerId]) wonTricks[t.winnerId] = [];
    wonTricks[t.winnerId].push({ cards: t.cards, trickNumber: t.trickNumber });
  });
  const done = state.turnOrder.every((pid) => ((state.hands[pid] || []).length === 0)) ||
    // 3인 등 나눠떨어지지 않을 때: 낼 수 있는 사람이 더 없으면 종료로 간주
    (state.trick && state.trick.length === 0 && state.turnOrder.some((pid) => (state.hands[pid] || []).length === 0) &&
      !state.turnOrder.every((pid) => (state.hands[pid] || []).length > 0));

  const ctx0 = { wonTricks, allTricks, turnOrder: state.turnOrder, done };

  return (state.targetCards || []).map((task) => {
    if (task.status !== 'pending') return task;
    const def = TASK_MAP[task.key];
    if (!def) return task;
    const status = def.evaluate({ ...ctx0, ownerId: task.ownerId });
    return { ...task, status };
  });
}

function applyCardPlay(state, playerId, card) {
  const hand = (state.hands && state.hands[playerId]) || [];
  const newHand = hand.filter((c) => c.id !== card.id);
  const newHands = { ...(state.hands || {}), [playerId]: newHand };
  const newTrick = [...(state.trick || []), { playerId, card }];
  let updated = { ...state, hands: newHands, trick: newTrick };

  if (newTrick.length === state.turnOrder.length) {
    const winner = resolveTrickWinner(newTrick);
    const history = [...(state.history || []), { winnerId: winner.playerId, cards: newTrick, trickNumber: state.trickNumber }];
    const allHaveCards = state.turnOrder.every((pid) => ((newHands[pid] || []).length > 0));

    let s2 = { ...updated, hands: newHands, history, trick: newTrick, trickResult: { winnerId: winner.playerId, cards: newTrick } };
    // 판정용 상태(트릭 비운 형태로 done 판정)
    const evalState = { ...s2, trick: allHaveCards ? newTrick : [] };
    const targetCards = evaluateAllTasks({ ...evalState, hands: newHands });
    const anyFailed = targetCards.some((t) => t.status === 'failed');
    const allDone = targetCards.every((t) => t.status !== 'pending');

    let missionStatus = 'playing';
    if (anyFailed) missionStatus = 'failed';
    else if (allDone) missionStatus = 'success';
    else if (!allHaveCards) missionStatus = 'failed';

    updated = { ...s2, targetCards, missionStatus, finished: missionStatus !== 'playing' };
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
  const dims = size === 'lg' ? { w: 50, h: 70, fs: 20 } : { w: 40, h: 56, fs: 16 };
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        width: dims.w, height: dims.h, borderRadius: 9,
        border: highlighted ? `2px solid #F0B84B` : `2px solid ${info.color}`,
        boxShadow: highlighted ? '0 0 0 3px rgba(240,184,74,0.35)' : 'none',
        background: card.suit === 'black' ? '#161C24' : `${info.color}1A`,
        color: info.color, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        opacity: disabled ? 0.4 : 1, flexShrink: 0,
        cursor: disabled ? 'default' : 'pointer', fontFamily: "'Space Grotesk', sans-serif",
      }}>
      <span style={{ fontSize: dims.fs, fontWeight: 700, lineHeight: 1 }}>{card.num}</span>
      <span style={{ fontSize: 8, marginTop: 2, letterSpacing: 0.3 }}>{info.label}</span>
    </button>
  );
}

function TaskCard({ task, room }) {
  const def = TASK_MAP[task.key];
  if (!def) return null;
  const icon = task.status === 'success' ? '✅' : task.status === 'failed' ? '❌' : '';
  const pointColor = def.point === 1 ? '#3FCB82' : def.point === 2 ? '#4C8DFF' : def.point === 3 ? '#F2C94C' : '#FF6FA5';
  return (
    <div style={{
      padding: '8px 10px', borderRadius: 9, marginBottom: 6,
      background: task.status === 'success' ? 'rgba(47,230,199,0.1)' : task.status === 'failed' ? 'rgba(255,111,165,0.1)' : 'rgba(255,255,255,0.04)',
      border: `1px solid ${task.ownerId ? 'rgba(240,184,74,0.35)' : 'rgba(255,255,255,0.08)'}`,
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <span style={{ fontSize: 10, fontWeight: 700, color: pointColor, border: `1px solid ${pointColor}`, borderRadius: 5, padding: '1px 5px', flexShrink: 0 }}>{def.point}점</span>
      <span style={{ fontSize: 13, flex: 1 }}>{def.label}</span>
      {task.ownerId && <span style={{ fontSize: 11, color: '#F0B84B', flexShrink: 0 }}>{playerName(room, task.ownerId)}</span>}
      {icon && <span style={{ fontSize: 12, flexShrink: 0 }}>{icon}</span>}
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

    const targetCards = drawTasksForLevel(level);

    const updated = {
      ...r, players, phase: 'draft', missionLevel: level, missionStatus: 'playing',
      hands, trick: [], turnOrder, captainId: captainId || turnOrder[0],
      draftIndex: 0, turnIndex: 0, trickNumber: 1, trickResult: null, targetCards, history: [],
    };
    await writeRoom(roomCode, updated);
    setRoom(updated);
    setScreen('game');
    setBusy(false);
  };

  const claimTask = async (taskKey) => {
    setBusy(true);
    const r = await readRoom(roomCode);
    if (!r || r.phase !== 'draft') { setBusy(false); return; }
    const order = r.turnOrder || [];
    const currentPicker = order[(r.draftIndex || 0) % order.length];
    if (currentPicker !== myId) { setBusy(false); return; }
    const targetCards = (r.targetCards || []).map((t) => t.key === taskKey && !t.ownerId ? { ...t, ownerId: myId } : t);
    const remaining = targetCards.filter((t) => !t.ownerId).length;
    let updated = { ...r, targetCards, draftIndex: (r.draftIndex || 0) + 1 };
    if (remaining === 0) updated.phase = 'play';
    await writeRoom(roomCode, updated);
    setRoom(updated);
    setBusy(false);
  };

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

  const draftPickerId = room && room.phase === 'draft' ? roomTurnOrder[(room.draftIndex || 0) % (roomTurnOrder.length || 1)] : null;
  const myDraftTurn = room && room.phase === 'draft' && draftPickerId === myId;
  const remainingTasks = roomTargetCards.filter((t) => !t.ownerId);
  const canPass = room && remainingTasks.length < (roomTurnOrder.length || 0);

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
  const myTasks = roomTargetCards.filter((t) => t.ownerId === myId);

  if (!authReady || !myId) {
    return <div style={{ ...pageStyle, display: 'flex', justifyContent: 'center' }}><div style={{ marginTop: 100, color: '#7FA6C2' }}>연결 중...</div></div>;
  }

  // ===== JOIN / LOBBY =====
  if (screen !== 'game' || !room) {
    return (
      <div style={{ ...pageStyle, padding: '24px 16px 40px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@500;600&family=Space+Grotesk:wght@400;500;700&display=swap'); *{box-sizing:border-box;} body{margin:0;}`}</style>
        <div style={{ width: '100%', maxWidth: 440 }}>
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
                레벨 {room.missionLevel || 1} · 난이도 총 {room.missionLevel || 1}점
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

  // ===== GAME =====
  return (
    <div style={{ ...pageStyle, display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@500;600&family=Space+Grotesk:wght@400;500;700&display=swap'); *{box-sizing:border-box;} body{margin:0;}`}</style>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 12px' }}>
        <div style={{ width: '100%', maxWidth: 460, margin: '0 auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#7FA6C2', marginBottom: 6 }}>
            <span>레벨 {room.missionLevel || 1} · 트릭 {room.trickNumber}</span>
            <span>방 {roomCode}</span>
          </div>
          {room.captainId && (
            <div style={{ textAlign: 'center', fontSize: 11, color: '#4A6E85', marginBottom: 12 }}>⚓ 캡틴: {playerName(room, room.captainId)}</div>
          )}

          {/* 미션 목표 리스트 */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: '#7FA6C2', marginBottom: 8 }}>미션 목표 ({roomTargetCards.length}개)</div>
            {roomTargetCards.map((t) => <TaskCard key={t.key} task={t} room={room} />)}
          </div>

          {/* 드래프트 안내 */}
          {room.phase === 'draft' && (
            <div style={{ background: '#103552', borderRadius: 14, padding: 16, marginBottom: 14, border: '1px solid rgba(240,184,74,0.25)' }}>
              <div style={{ ...headline, fontSize: 16, color: '#F0B84B', marginBottom: 6 }}>미션 분배</div>
              <div style={{ fontSize: 12, color: '#7FA6C2', marginBottom: 12 }}>
                아래 내 손패를 보고, 완수할 수 있는 미션을 가져가세요. 캡틴부터 순서대로 진행돼요. {canPass ? '(원하지 않으면 패스 가능)' : '(미션이 인원 수 이상이라 패스 불가)'}
              </div>
              <div style={{ textAlign: 'center', padding: 10, borderRadius: 10, background: myDraftTurn ? 'rgba(47,230,199,0.12)' : 'rgba(255,255,255,0.04)', color: myDraftTurn ? '#2FE6C7' : '#7FA6C2', fontSize: 14, fontWeight: 600, marginBottom: myDraftTurn ? 12 : 0 }}>
                {myDraftTurn ? '당신 차례 - 가져갈 미션을 고르세요' : `${playerName(room, draftPickerId)}님이 고르는 중...`}
              </div>
              {myDraftTurn && (
                <>
                  {remainingTasks.map((t) => {
                    const def = TASK_MAP[t.key];
                    return (
                      <button key={t.key} onClick={() => claimTask(t.key)} disabled={busy}
                        style={{ width: '100%', textAlign: 'left', padding: '10px 12px', borderRadius: 9, marginBottom: 6, border: '1px solid rgba(47,230,199,0.4)', background: 'rgba(47,230,199,0.06)', color: '#EAF6F6', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                        <span style={{ color: '#2FE6C7', fontWeight: 700, marginRight: 6 }}>[{def.point}점]</span>{def.label}
                      </button>
                    );
                  })}
                  {canPass && (
                    <button onClick={passTask} disabled={busy} style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid rgba(255,255,255,0.2)', background: 'transparent', color: '#7FA6C2', fontSize: 13, cursor: 'pointer', marginTop: 4 }}>패스 (안 가져가기)</button>
                  )}
                </>
              )}
            </div>
          )}

          {/* 진행중 안내 */}
          {inPlay && (
            <div style={{ textAlign: 'center', marginBottom: 12, padding: 10, borderRadius: 10, background: myTurn ? 'rgba(47,230,199,0.12)' : 'rgba(255,255,255,0.04)', color: myTurn ? '#2FE6C7' : '#7FA6C2', fontSize: 14, fontWeight: 600 }}>
              {room.trickResult ? '트릭 결과 확인' : myTurn ? '지금 당신의 차례예요' : `${playerName(room, roomTurnOrder[room.turnIndex])}님의 차례`}
            </div>
          )}

          {/* 현재 트릭 */}
          {room.phase !== 'draft' && (
            <div style={{ background: '#103552', borderRadius: 16, padding: 16, minHeight: 100, marginBottom: 12, border: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ fontSize: 12, color: '#7FA6C2', marginBottom: 10 }}>{!inPlay ? '마지막 트릭' : '현재 트릭'}</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {(room.trickResult ? room.trickResult.cards : roomTrick).map((t) => (
                  <div key={t.playerId} style={{ textAlign: 'center' }}>
                    <CardView card={t.card} disabled />
                    <div style={{ fontSize: 11, color: '#7FA6C2', marginTop: 4 }}>{playerName(room, t.playerId)}</div>
                  </div>
                ))}
                {roomTrick.length === 0 && !room.trickResult && inPlay && <div style={{ color: '#4A6E85', fontSize: 13 }}>아직 낸 카드가 없어요</div>}
              </div>
            </div>
          )}

          {room.trickResult && inPlay && (
            <div style={{ textAlign: 'center', marginBottom: 14 }}>
              <div style={{ color: '#2FE6C7', fontWeight: 700, marginBottom: 10 }}>{playerName(room, room.trickResult.winnerId)}님이 트릭을 가져갔어요</div>
              <button onClick={nextTrick} disabled={busy} style={{ padding: '10px 22px', borderRadius: 10, border: 'none', background: '#2FE6C7', color: '#05121F', fontWeight: 700, cursor: 'pointer' }}>다음 트릭</button>
            </div>
          )}

          {room.missionStatus === 'success' && (
            <div style={{ background: 'rgba(47,230,199,0.1)', borderRadius: 16, padding: 20, border: '1px solid rgba(47,230,199,0.3)', marginBottom: 14, textAlign: 'center' }}>
              <div style={{ ...headline, fontSize: 20, marginBottom: 10, color: '#2FE6C7' }}>🎉 레벨 {room.missionLevel} 성공!</div>
              {isHost ? (
                <button onClick={() => startMission((room.missionLevel || 1) + 1)} disabled={busy} style={{ padding: '10px 22px', borderRadius: 10, border: 'none', background: '#2FE6C7', color: '#05121F', fontWeight: 700, cursor: 'pointer' }}>다음 미션 (레벨 {(room.missionLevel || 1) + 1})</button>
              ) : <div style={{ color: '#7FA6C2', fontSize: 13 }}>방장이 다음 미션을 시작하길 기다리는 중...</div>}
            </div>
          )}

          {room.missionStatus === 'failed' && (
            <div style={{ background: 'rgba(255,111,165,0.1)', borderRadius: 16, padding: 20, border: '1px solid rgba(255,111,165,0.3)', marginBottom: 14, textAlign: 'center' }}>
              <div style={{ ...headline, fontSize: 20, marginBottom: 10, color: '#FF6FA5' }}>미션 실패 - 레벨 {room.missionLevel}</div>
              {isHost ? (
                <button onClick={() => startMission(room.missionLevel || 1)} disabled={busy} style={{ padding: '10px 22px', borderRadius: 10, border: 'none', background: '#FF6FA5', color: '#05121F', fontWeight: 700, cursor: 'pointer' }}>같은 레벨 다시 도전</button>
              ) : <div style={{ color: '#7FA6C2', fontSize: 13 }}>방장이 재도전을 시작하길 기다리는 중...</div>}
            </div>
          )}
        </div>
      </div>

      {/* 하단 고정 손패 - 드래프트/플레이 모두 표시, wrap으로 한눈에 */}
      {(room.phase === 'draft' || inPlay) && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', background: '#0A2438', padding: '10px 16px 14px', maxHeight: '42vh', overflowY: 'auto' }}>
          <div style={{ width: '100%', maxWidth: 460, margin: '0 auto' }}>
            <div style={{ fontSize: 11, color: '#7FA6C2', marginBottom: 6 }}>
              내 손패 ({myHand.length}장){myTasks.length > 0 ? ` · 내 미션 ${myTasks.length}개` : ''}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {myHand.map((card) => (
                <CardView key={card.id} card={card} size="lg"
                  disabled={room.phase === 'draft' || !myTurn || !!room.trickResult || !canPlay(card)}
                  onClick={() => playCard(card)} />
              ))}
            </div>
            {ledSuit && inPlay && !room.trickResult && (
              <div style={{ fontSize: 11, color: '#4A6E85', marginTop: 6 }}>리드 수트: {SUIT_INFO[ledSuit].label} (가능하면 같은 수트를 내야 해요)</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
