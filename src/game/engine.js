'use strict';
import { COLOR_SUITS, SUBMARINE, cardId, buildDeck, shuffle, sortHand, dealCards, findCaptainSeat } from './cards';
import { TASKS, IMMEDIATE_FAIL_TYPES, EARLY_SUCCESS_TYPES } from './tasks';

const TASKS_BY_ID = Object.fromEntries(TASKS.map((t) => [t.id, t]));
const LAST_TRICK_INDEX = { 3: 13, 4: 10, 5: 8 };

function sameCard(a, b) { return a.suit === b.suit && a.value === b.value; }

class Game {
  constructor(numPlayers, options = {}) {
    if (numPlayers < 3 || numPlayers > 5) throw new Error('인원은 3~5명이어야 합니다.');
    this.numPlayers = numPlayers;
    this.options = { rescueSignalEnabled: !!options.rescueSignalEnabled };
    this.seats = Array.from({ length: numPlayers }, (_, i) => ({ seat: i, playerId: null, name: null }));
    this.log = [];
    this.taskDeck = { drawPile: shuffle(TASKS.map((t) => t.id)), discardPile: [] };
    this.missionNumber = 0;
    this.attemptNumber = 0;
    this.failedAttemptsThisMission = 0;
    this.phase = 'lobby';
    this.resetMissionState();
  }

  addLog(msg) {
    this.log.push({ t: Date.now(), msg });
    if (this.log.length > 300) this.log.shift();
  }

  resetMissionState() {
    this.hands = null;
    this.removedCard = null;
    this.removedFromSeat = null;
    this.captainSeat = -1;
    this.taskPool = [];
    this.taskAssignment = {};
    this.taskOwnerPasses = new Set();
    this.taskSelectionOrder = [];
    this.taskSelectionTurnIdx = 0;
    this.taskSelectionCycleStartCount = 0;
    this.tricks = [];
    this.currentTrick = null;
    this.nextLeader = -1;
    this.comm = {};
    this.rescue = null;
    this.predictions = {};
    this.missionResult = null;
    this.missionDifficulty = null;
    this.pendingPredictionTasks = [];
    this._taskSelectionRestartGuard = 0;
    this.missionModifiers = { freeDistribution: false, noCommunication: false, timeLimitSeconds: null };
    this.missionDeadlineAt = null;
    this.timeExpired = false;
  }

  startMission(missionNumber, difficulty, modifiers = {}) {
    this.resetMissionState();
    this.missionNumber = missionNumber;
    this.missionDifficulty = difficulty;
    this.attemptNumber = 0;
    this.failedAttemptsThisMission = 0;
    this.missionModifiers = {
      freeDistribution: !!modifiers.freeDistribution,
      noCommunication: !!modifiers.noCommunication,
      timeLimitSeconds: modifiers.timeLimitSeconds ? Number(modifiers.timeLimitSeconds) : null,
    };
    if (this.missionModifiers.timeLimitSeconds) {
      this.missionDeadlineAt = Date.now() + this.missionModifiers.timeLimitSeconds * 1000;
    }
    this._selectTasksForMission(difficulty);
    this._dealAndResolveRedistribution();
    this.phase = 'taskSelection';
    this._initTaskSelectionOrder();
    const modNote = [];
    if (this.missionModifiers.freeDistribution) modNote.push('자유분배');
    if (this.missionModifiers.noCommunication) modNote.push('통신금지');
    if (this.missionModifiers.timeLimitSeconds) modNote.push(`제한시간 ${Math.round(this.missionModifiers.timeLimitSeconds / 60)}분`);
    this.addLog(`임무 #${missionNumber} 시작 (목표 난이도 ${difficulty}${modNote.length ? ', ' + modNote.join('/') : ''}). 선택된 과제: ${this.taskPool.join(', ')}`);
  }

  _selectTasksForMission(D) {
    const maxFullRetries = 200;
    for (let attempt = 0; attempt < maxFullRetries; attempt++) {
      const pool = shuffle(this.taskDeck.drawPile.concat(this.taskDeck.discardPile));
      let remaining = D;
      const selected = [];
      const skipped = [];
      let idx = 0;
      let feasible = true;
      while (remaining > 0) {
        if (idx >= pool.length) { feasible = false; break; }
        const topId = pool[idx];
        idx += 1;
        const task = TASKS_BY_ID[topId];
        const cost = task.difficulty[this.numPlayers];
        if (cost <= remaining) { selected.push(topId); remaining -= cost; }
        else { skipped.push(topId); }
      }
      if (feasible && remaining === 0) {
        const untouched = pool.slice(idx);
        this.taskDeck.drawPile = skipped.concat(untouched);
        this.taskDeck.discardPile = [];
        this.taskPool = selected;
        return;
      }
    }
    throw new Error(`목표 난이도 ${D}를 만족하는 과제 조합을 찾지 못했습니다 (인원 ${this.numPlayers}인). D 값을 확인해주세요.`);
  }

  _dealAndResolveRedistribution() {
    const relevantTasks = this.taskPool.map((id) => TASKS_BY_ID[id]);
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const deck = shuffle(buildDeck());
      const { hands, removedCard, removedFromSeat } = dealCards(deck, this.numPlayers);
      const noCaptainPossible = findCaptainSeat(hands, this.numPlayers) === -1;
      const needsRedistribute = noCaptainPossible || relevantTasks.some((task) => this._checkNeedsRedistribute(task, hands));
      if (!needsRedistribute || attempts > 200) {
        this.hands = hands;
        this.removedCard = removedCard;
        this.removedFromSeat = removedFromSeat;
        this.captainSeat = findCaptainSeat(hands, this.numPlayers);
        this.attemptNumber += 1;
        return;
      }
      this.addLog('카드 분배가 특정 잠수함 과제와 구조적으로 충돌하여 재분배합니다 (실패로 계산되지 않음).');
    }
  }

  _checkNeedsRedistribute(task, hands) {
    const subsOf = (hand) => hand.filter((c) => c.suit === SUBMARINE).map((c) => c.value);
    if (task.type === 'submarineCountExact' && task.params.redistributeIfAllFourToOnePlayer) {
      return hands.some((h) => [1, 2, 3, 4].every((v) => subsOf(h).includes(v)));
    }
    if (task.type === 'submarineCountExact' && task.params.redistributeIfAllOf) {
      const need = task.params.redistributeIfAllOf;
      return hands.some((h) => need.every((v) => subsOf(h).includes(v)));
    }
    if (task.type === 'submarineExactAndOnly') {
      const main = task.params.mainValue;
      return hands.some((h) => {
        const subs = subsOf(h);
        if (!subs.includes(main)) return false;
        const togetherHit = (task.params.redistributeIfTogether || []).some((v) => subs.includes(v));
        const allOfHit = task.params.redistributeIfAllOf ? task.params.redistributeIfAllOf.every((v) => subs.includes(v)) : false;
        return togetherHit || allOfHit;
      });
    }
    return false;
  }

  _initTaskSelectionOrder() {
    this.taskSelectionOrder = Array.from({ length: this.numPlayers }, (_, i) => (this.captainSeat + i) % this.numPlayers);
    this.taskSelectionTurnIdx = 0;
    this.taskSelectionCycleStartCount = this.taskPool.length;
    this.taskOwnerPasses = new Set();
    this._ensureTaskSelectionFeasible();
  }

  get unassignedTasks() { return this.taskPool.filter((id) => this.taskAssignment[id] === undefined); }

  currentTaskSelector() {
    if (this.phase !== 'taskSelection') return -1;
    if (this.unassignedTasks.length === 0) return -1;
    if (this.missionModifiers.freeDistribution) return -1;
    return this.taskSelectionOrder[this.taskSelectionTurnIdx % this.taskSelectionOrder.length];
  }

  canPassTaskSelection() {
    if (this.missionModifiers.freeDistribution) return false;
    const total = this.taskSelectionCycleStartCount;
    if (total >= this.numPlayers) return false;
    const cyclePos = this.taskSelectionTurnIdx;
    if (cyclePos >= this.numPlayers) return false;
    const seatsRemainingInCycleInclusive = this.numPlayers - cyclePos;
    return this.unassignedTasks.length < seatsRemainingInCycleInclusive;
  }

  chooseTask(seat, taskId) {
    if (this.phase !== 'taskSelection') throw new Error('지금은 과제 선택 단계가 아닙니다.');
    if (!this.missionModifiers.freeDistribution && this.currentTaskSelector() !== seat) throw new Error('당신의 차례가 아닙니다.');
    if (!this.unassignedTasks.includes(taskId)) throw new Error('선택할 수 없는 과제입니다.');
    const task = TASKS_BY_ID[taskId];
    if (task.captainCannotOwn && seat === this.captainSeat) throw new Error('선장은 이 과제를 선택할 수 없습니다.');
    this.taskAssignment[taskId] = seat;
    this.addLog(`${this._seatLabel(seat)}가 과제 ${taskId}를 선택했습니다.`);
    if (!this.missionModifiers.freeDistribution) this._advanceTaskSelectionTurn();
    this._afterTaskAssignmentComplete();
  }

  passTaskSelection(seat) {
    if (this.phase !== 'taskSelection') throw new Error('지금은 과제 선택 단계가 아닙니다.');
    if (this.currentTaskSelector() !== seat) throw new Error('당신의 차례가 아닙니다.');
    if (!this.canPassTaskSelection()) throw new Error('지금은 패스할 수 없습니다.');
    this.addLog(`${this._seatLabel(seat)}가 과제 선택을 패스했습니다.`);
    this._advanceTaskSelectionTurn();
    this._afterTaskAssignmentComplete();
  }

  _advanceTaskSelectionTurn() {
    this.taskSelectionTurnIdx += 1;
    if (this.unassignedTasks.length > 0 && this.taskSelectionTurnIdx >= this.taskSelectionOrder.length) {
      this.taskSelectionOrder = Array.from({ length: this.numPlayers }, (_, i) => (this.captainSeat + i) % this.numPlayers);
      this.taskSelectionTurnIdx = 0;
      this.taskSelectionCycleStartCount = this.numPlayers;
    }
    this._ensureTaskSelectionFeasible();
  }

  _ensureTaskSelectionFeasible() {
    if (this.missionModifiers.freeDistribution) return;
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 50) return;
      if (this.phase !== 'taskSelection') return;
      const unassigned = this.unassignedTasks;
      if (unassigned.length === 0) return;
      const seat = this.taskSelectionOrder[this.taskSelectionTurnIdx % this.taskSelectionOrder.length];
      if (seat !== this.captainSeat) return;
      if (this.canPassTaskSelection()) return;
      const avail = unassigned.filter((id) => !TASKS_BY_ID[id].captainCannotOwn);
      if (avail.length > 0) return;
      const conflictId = unassigned.slice().sort((a, b) => this.taskPool.indexOf(b) - this.taskPool.indexOf(a))[0];
      const cost = TASKS_BY_ID[conflictId].difficulty[this.numPlayers];
      const replacementId = this._drawReplacementTask(cost, conflictId);
      const idx = this.taskPool.indexOf(conflictId);
      if (replacementId) {
        this.taskPool[idx] = replacementId;
        this.taskDeck.discardPile.push(conflictId);
        this.addLog(`과제 충돌 감지: ${conflictId} → ${replacementId}로 교체했습니다.`);
      } else {
        this._restartTaskSelectionFromScratch();
        return;
      }
    }
  }

  _restartTaskSelectionFromScratch() {
    this._taskSelectionRestartGuard = (this._taskSelectionRestartGuard || 0) + 1;
    if (this._taskSelectionRestartGuard > 20) {
      throw new Error(`목표 난이도 ${this.missionDifficulty}에서 선장 선택 제한 과제들의 조합 충돌을 해소하지 못했습니다.`);
    }
    this.taskDeck.discardPile.push(...this.taskPool);
    this.taskAssignment = {};
    this.taskOwnerPasses = new Set();
    this._selectTasksForMission(this.missionDifficulty);
    this.addLog(`과제 조합의 충돌을 개별 교체로 해소할 수 없어, 이번 임무의 과제를 전부 다시 뽑았습니다: ${this.taskPool.join(', ')}`);
    this._initTaskSelectionOrder();
  }

  _drawReplacementTask(cost, excludeId) {
    let guard = 0;
    const skipped = [];
    let found = null;
    while (guard < 200) {
      guard += 1;
      if (this.taskDeck.drawPile.length === 0) {
        if (this.taskDeck.discardPile.length === 0) break;
        this.taskDeck.drawPile = shuffle(this.taskDeck.discardPile);
        this.taskDeck.discardPile = [];
      }
      const topId = this.taskDeck.drawPile.shift();
      const task = TASKS_BY_ID[topId];
      if (topId !== excludeId && !this.taskPool.includes(topId) && task.difficulty[this.numPlayers] === cost) { found = topId; break; }
      skipped.push(topId);
    }
    this.taskDeck.drawPile.push(...skipped);
    return found;
  }

  rescueChooseDirection(seat, direction) {
    if (this.phase !== 'rescueSignal' || this.rescue.step !== 'direction') throw new Error('지금은 방향 선택 단계가 아닙니다.');
    if (!['left', 'right'].includes(direction)) throw new Error('방향은 left 또는 right 여야 합니다.');
    this.rescue.directionChoice[seat] = direction;
    const values = Object.values(this.rescue.directionChoice);
    if (values.length === this.numPlayers) {
      const allSame = values.every((v) => v === values[0]);
      if (allSame) {
        this.rescue.direction = values[0];
        this.rescue.step = 'passOrNot';
        this.addLog(`구조신호 방향: ${values[0] === 'left' ? '왼쪽' : '오른쪽'}`);
      } else {
        this.rescue.directionChoice = {};
        this.addLog('방향 선택이 일치하지 않아 다시 선택합니다.');
      }
    }
  }

  rescueChoosePassOrNot(seat, willPass) {
    if (this.phase !== 'rescueSignal' || this.rescue.step !== 'passOrNot') throw new Error('지금은 전달 여부 선택 단계가 아닙니다.');
    this.rescue.passChoice[seat] = !!willPass;
    const values = Object.values(this.rescue.passChoice);
    if (values.length === this.numPlayers) {
      const allSame = values.every((v) => v === values[0]);
      if (!allSame) { this.rescue.passChoice = {}; this.addLog('전달 여부가 일치하지 않아 다시 선택합니다.'); return; }
      if (values[0] === false) { this.addLog('전원 카드를 전달하지 않기로 했습니다.'); this._afterRescuePhase(); }
      else { this.rescue.step = 'chooseCard'; this.addLog('전원 이웃에게 카드 1장을 전달합니다. 전달할 카드를 선택해주세요.'); }
    }
  }

  rescueChooseCard(seat, card) {
    if (this.phase !== 'rescueSignal' || this.rescue.step !== 'chooseCard') throw new Error('지금은 카드 선택 단계가 아닙니다.');
    if (card.suit === SUBMARINE) throw new Error('잠수함 카드는 전달할 수 없습니다.');
    const hand = this.hands[seat];
    if (!hand.some((c) => sameCard(c, card))) throw new Error('손에 없는 카드입니다.');
    this.rescue.cardsGiven[seat] = card;
    if (Object.keys(this.rescue.cardsGiven).length === this.numPlayers) this._executeRescueTransfer();
  }

  _executeRescueTransfer() {
    const dir = this.rescue.direction;
    const n = this.numPlayers;
    const incoming = {};
    for (let seat = 0; seat < n; seat++) {
      const targetSeat = dir === 'left' ? (seat - 1 + n) % n : (seat + 1) % n;
      incoming[targetSeat] = this.rescue.cardsGiven[seat];
    }
    for (let seat = 0; seat < n; seat++) {
      const given = this.rescue.cardsGiven[seat];
      this.hands[seat] = this.hands[seat].filter((c) => !sameCard(c, given));
    }
    for (let seat = 0; seat < n; seat++) this.hands[seat] = sortHand([...this.hands[seat], incoming[seat]]);
    this.addLog('구조신호 카드 전달이 완료되었습니다.');
    this._afterRescuePhase();
  }

  _afterTaskAssignmentComplete() {
    if (this.unassignedTasks.length === 0) {
      this.pendingPredictionTasks = this.taskPool.filter((id) => {
        const t = TASKS_BY_ID[id];
        return t.type === 'predictTrickCountOpen' || t.type === 'predictTrickCountSecret';
      });
      if (this.options.rescueSignalEnabled) {
        this.phase = 'rescueSignal';
        this.rescue = { step: 'direction', directionChoice: {}, passChoice: {}, cardsGiven: {}, direction: null };
        this.addLog('구조신호 단계: 전달 방향을 정해주세요.');
      } else {
        this._afterRescuePhase();
      }
    }
  }

  _afterRescuePhase() {
    if (this.pendingPredictionTasks.length > 0) {
      this.phase = 'prediction';
      this.addLog('트릭 수 예측을 입력해주세요: ' + this.pendingPredictionTasks.join(', '));
    } else {
      this._beginPlay();
    }
  }

  submitPrediction(seat, taskId, value) {
    if (this.phase !== 'prediction') throw new Error('지금은 예측 단계가 아닙니다.');
    const task = TASKS_BY_ID[taskId];
    if (!task) throw new Error('알 수 없는 과제입니다.');
    if (this.taskAssignment[taskId] !== seat) throw new Error('본인의 과제가 아닙니다.');
    if (!this.pendingPredictionTasks.includes(taskId)) throw new Error('예측이 필요없는 과제입니다.');
    const lastIdx = LAST_TRICK_INDEX[this.numPlayers];
    if (value < 0 || value > lastIdx) throw new Error(`0~${lastIdx} 사이 값이어야 합니다.`);
    this.predictions[taskId] = { value, secret: task.type === 'predictTrickCountSecret', revealed: task.type !== 'predictTrickCountSecret' };
    this.pendingPredictionTasks = this.pendingPredictionTasks.filter((id) => id !== taskId);
    this.addLog(`${this._seatLabel(seat)}가 예측을 기록했습니다 (${task.type === 'predictTrickCountSecret' ? '비공개' : '공개: ' + value}).`);
    if (this.pendingPredictionTasks.length === 0) this._beginPlay();
  }

  _beginPlay() {
    this.phase = 'playing';
    this.nextLeader = this.captainSeat;
    this._startTrick();
    this.addLog('첫 트릭을 시작합니다. 선장이 리드합니다.');
  }

  _startTrick() {
    this.currentTrick = { trickIndex: this.tricks.length + 1, leaderSeat: this.nextLeader, leadSuit: null, plays: [] };
  }

  checkTimeExpired() {
    if (this.phase !== 'playing' && this.phase !== 'taskSelection' && this.phase !== 'rescueSignal' && this.phase !== 'prediction') return false;
    if (!this.missionDeadlineAt) return false;
    if (Date.now() < this.missionDeadlineAt) return false;
    this.timeExpired = true;
    this._endMission('fail', '제한시간을 초과했습니다');
    return true;
  }

  communicate(seat, card) {
    if (this.phase !== 'playing') throw new Error('지금은 통신할 수 없습니다.');
    if (this.missionModifiers.noCommunication) throw new Error('이 임무는 통신이 완전히 금지되어 있습니다.');
    if (this.currentTrick.plays.length > 0) throw new Error('트릭 진행 중에는 통신할 수 없습니다.');
    if (this.comm[seat] && this.comm[seat].used) throw new Error('이번 임무에서 이미 통신을 사용했습니다.');
    if (card.suit === SUBMARINE) throw new Error('잠수함 카드는 통신에 사용할 수 없습니다.');
    const hand = this.hands[seat];
    if (!hand.some((c) => sameCard(c, card))) throw new Error('손에 없는 카드입니다.');
    const sameSuit = hand.filter((c) => c.suit === card.suit);
    const values = sameSuit.map((c) => c.value);
    let position;
    if (sameSuit.length === 1) position = 'ONLY';
    else if (card.value === Math.max(...values)) position = 'HIGHEST';
    else if (card.value === Math.min(...values)) position = 'LOWEST';
    else throw new Error('해당 카드는 통신 조건(최고/유일/최저)을 만족하지 않습니다.');
    this.comm[seat] = { card, position, active: true, used: true };
    this.addLog(`${this._seatLabel(seat)}가 통신: ${card.suit} ${card.value} (${position})`);
  }

  currentPlayerToAct() {
    if (this.phase !== 'playing' || !this.currentTrick) return -1;
    const n = this.numPlayers;
    const k = this.currentTrick.plays.length;
    return (this.currentTrick.leaderSeat + k) % n;
  }

  legalCardsFor(seat) {
    const hand = this.hands[seat];
    const lead = this.currentTrick.leadSuit;
    if (!lead) return hand.slice();
    const matching = hand.filter((c) => c.suit === lead);
    return matching.length > 0 ? matching : hand.slice();
  }

  playCard(seat, card) {
    if (this.phase !== 'playing') throw new Error('지금은 카드를 낼 수 없습니다.');
    if (this.currentPlayerToAct() !== seat) throw new Error('당신의 차례가 아닙니다.');
    const hand = this.hands[seat];
    const idx = hand.findIndex((c) => sameCard(c, card));
    if (idx === -1) throw new Error('손에 없는 카드입니다.');
    const legal = this.legalCardsFor(seat);
    if (!legal.some((c) => sameCard(c, card))) throw new Error('수트를 따라야 합니다 (Follow suit 위반).');
    hand.splice(idx, 1);
    this.currentTrick.plays.push({ seat, card });
    if (!this.currentTrick.leadSuit) this.currentTrick.leadSuit = card.suit;
    if (this.comm[seat] && this.comm[seat].active && sameCard(this.comm[seat].card, card)) this.comm[seat].active = false;
    if (this.currentTrick.plays.length === this.numPlayers) this._resolveTrick();
  }

  _resolveTrick() {
    const trick = this.currentTrick;
    const subPlays = trick.plays.filter((p) => p.card.suit === SUBMARINE);
    let winner;
    if (subPlays.length > 0) winner = subPlays.reduce((a, b) => (b.card.value > a.card.value ? b : a)).seat;
    else { const leadPlays = trick.plays.filter((p) => p.card.suit === trick.leadSuit); winner = leadPlays.reduce((a, b) => (b.card.value > a.card.value ? b : a)).seat; }
    trick.winnerSeat = winner;
    this.tricks.push(trick);
    this.nextLeader = winner;
    this.currentTrick = null;
    this.addLog(`트릭 #${trick.trickIndex} 승자: ${this._seatLabel(winner)}`);

    if (this.checkTimeExpired()) return;

    const failedTask = this._checkImmediateFailures();
    if (failedTask) { this._endMission('fail', `과제 ${failedTask} 실패 조건 충족`); return; }

    const lastIdx = LAST_TRICK_INDEX[this.numPlayers];
    if (this.tricks.length >= lastIdx) { this._finalizeMission(); return; }
    if (this._checkEarlySuccess()) {
      this._endMission('success', '모든 과제가 조기 완료 조건을 충족하여 남은 트릭 없이 임무 성공');
      return;
    }
    this._startTrick();
  }

  _checkImmediateFailures() {
    for (const taskId of this.taskPool) {
      const task = TASKS_BY_ID[taskId];
      if (!IMMEDIATE_FAIL_TYPES.has(task.type)) continue;
      const owner = this.taskAssignment[taskId];
      if (this._isImmediateFail(task, owner)) return taskId;
    }
    return null;
  }

  _checkEarlySuccess() {
    if (this.taskPool.length === 0) return false;
    for (const taskId of this.taskPool) {
      const task = TASKS_BY_ID[taskId];
      if (!EARLY_SUCCESS_TYPES.has(task.type)) return false;
      const owner = this.taskAssignment[taskId];
      if (!this._isTaskSatisfiedFinal(task, owner)) return false;
    }
    return true;
  }

  _finalizeMission() {
    const failures = [];
    for (const taskId of this.taskPool) {
      const task = TASKS_BY_ID[taskId];
      const owner = this.taskAssignment[taskId];
      if (!this._isTaskSatisfiedFinal(task, owner)) failures.push(taskId);
    }
    if (failures.length === 0) this._endMission('success');
    else this._endMission('fail', `미충족 과제: ${failures.join(', ')}`);
  }

  _endMission(result, reason) {
    this.missionResult = result;
    this.phase = 'missionEnd';
    this.taskDeck.discardPile.push(...this.taskPool);
    if (result === 'fail') this.failedAttemptsThisMission += 1;
    this.addLog(`임무 결과: ${result === 'success' ? '성공' : '실패'}${reason ? ' - ' + reason : ''}`);
  }

  retryMission() {
    if (this.phase !== 'missionEnd' || this.missionResult !== 'fail') throw new Error('재시도할 수 없는 상태입니다.');
    const keptTaskPool = this.taskPool;
    const keptMissionNumber = this.missionNumber;
    const keptDifficulty = this.missionDifficulty;
    const keptModifiers = this.missionModifiers;
    this.resetMissionState();
    for (const id of keptTaskPool) {
      const idx = this.taskDeck.discardPile.indexOf(id);
      if (idx !== -1) this.taskDeck.discardPile.splice(idx, 1);
    }
    this.taskPool = keptTaskPool;
    this.missionNumber = keptMissionNumber;
    this.missionDifficulty = keptDifficulty;
    this.missionModifiers = keptModifiers;
    if (this.missionModifiers.timeLimitSeconds) {
      this.missionDeadlineAt = Date.now() + this.missionModifiers.timeLimitSeconds * 1000;
    }
    this._dealAndResolveRedistribution();
    this.phase = 'taskSelection';
    this._initTaskSelectionOrder();
    this.addLog('임무를 재시도합니다 (카드 재분배, 트릭 기록 초기화, 제한시간 있으면 재시작).');
  }

  surrenderMission(seat) {
    if (this.phase === 'lobby' || this.phase === 'missionEnd') throw new Error('지금은 포기할 수 있는 상태가 아닙니다.');
    this._endMission('fail', `${this._seatLabel(seat)}가 임무 포기를 선언했습니다`);
  }

  _wonCards(seat) {
    const out = [];
    for (const t of this.tricks) { if (t.winnerSeat === seat) for (const p of t.plays) out.push(p.card); }
    return out;
  }
  _wonTrickIndexes(seat) { return this.tricks.filter((t) => t.winnerSeat === seat).map((t) => t.trickIndex); }
  _colorCount(seat, suit) { return this._wonCards(seat).filter((c) => c.suit === suit).length; }
  _numberCount(seat, value) { return this._wonCards(seat).filter((c) => c.suit !== SUBMARINE && c.value === value).length; }
  _submarineCount(seat) { return this._wonCards(seat).filter((c) => c.suit === SUBMARINE).length; }
  _hasSubmarineValue(seat, v) { return this._wonCards(seat).some((c) => c.suit === SUBMARINE && c.value === v); }
  _consecutiveRuns(seat) {
    const idxs = this._wonTrickIndexes(seat).sort((a, b) => a - b);
    const runs = []; let cur = [];
    for (const i of idxs) { if (cur.length === 0 || i === cur[cur.length - 1] + 1) cur.push(i); else { runs.push(cur); cur = [i]; } }
    if (cur.length) runs.push(cur);
    return runs.map((r) => r.length);
  }
  _otherSeats(seat) { return this.seats.map((s) => s.seat).filter((s) => s !== seat); }
  _cardOfSeatInTrick(trick, seat) { const p = trick.plays.find((pp) => pp.seat === seat); return p ? p.card : null; }

  _isImmediateFail(task, owner) {
    const p = task.params;
    switch (task.type) {
      case 'colorCountExact': return this._colorCount(owner, p.suit) > p.count;
      case 'colorCountExactMulti': return Object.entries(p.counts).some(([suit, cnt]) => this._colorCount(owner, suit) > cnt);
      case 'numberCountExact': return this._numberCount(owner, p.value) > p.count;
      case 'numberCountExactMulti': return Object.entries(p.counts).some(([val, cnt]) => this._numberCount(owner, Number(val)) > cnt);
      case 'noTricksInRange': return this._wonTrickIndexes(owner).some((i) => i >= p.from && i <= p.to);
      case 'noTricksAtAll': return this._wonTrickIndexes(owner).length > 0;
      case 'neverConsecutiveTricks': return this._consecutiveRuns(owner).some((len) => len >= 2);
      case 'winOnlyTrick': { const target = p.trick === 'last' ? LAST_TRICK_INDEX[this.numPlayers] : p.trick; return this._wonTrickIndexes(owner).some((i) => i !== target); }
      case 'neverLeadWithSuits': return this.tricks.some((t) => t.leaderSeat === owner && p.suits.includes(t.leadSuit));
      case 'submarineCountExact': return this._submarineCount(owner) > p.count;
      case 'submarineExactAndOnly': {
        const cnt = this._submarineCount(owner);
        const wrongOwned = this._wonCards(owner).some((c) => c.suit === SUBMARINE && c.value !== p.mainValue);
        return wrongOwned || cnt > 1;
      }
      case 'winExactlyNTricks': return this._wonTrickIndexes(owner).length > p.n;
      default: return false;
    }
  }

  _isTaskSatisfiedFinal(task, owner) {
    const p = task.params;
    const others = this._otherSeats(owner);
    switch (task.type) {
      case 'trickCountMoreThanAllOthers': return others.every((o) => this._wonTrickIndexes(owner).length > this._wonTrickIndexes(o).length);
      case 'trickCountMoreThanSumOthers': { const sum = others.reduce((a, o) => a + this._wonTrickIndexes(o).length, 0); return this._wonTrickIndexes(owner).length > sum; }
      case 'trickCountFewerThanAllOthers': return others.every((o) => this._wonTrickIndexes(owner).length < this._wonTrickIndexes(o).length);
      case 'trickCountMoreThanCaptain': return this._wonTrickIndexes(owner).length > this._wonTrickIndexes(this.captainSeat).length;
      case 'trickCountFewerThanCaptain': return this._wonTrickIndexes(owner).length < this._wonTrickIndexes(this.captainSeat).length;
      case 'trickCountEqualCaptain': return this._wonTrickIndexes(owner).length === this._wonTrickIndexes(this.captainSeat).length;
      case 'trickAllColorValuesUnder':
        return this.tricks.some((t) => t.winnerSeat === owner && !t.plays.some((pl) => pl.card.suit === SUBMARINE) && t.plays.every((pl) => pl.card.value < p.under));
      case 'trickAllColorValuesOver':
        return this.tricks.some((t) => t.winnerSeat === owner && !t.plays.some((pl) => pl.card.suit === SUBMARINE) && t.plays.every((pl) => pl.card.value > p.over));
      case 'trickContainsColorValue':
        return this.tricks.some((t) => t.winnerSeat === owner && t.plays.some((pl) => pl.card.suit !== SUBMARINE && pl.card.value === p.value));
      case 'winningCardCapturesCard':
        return this.tricks.some((t) => {
          if (t.winnerSeat !== owner) return false;
          const winCard = this._cardOfSeatInTrick(t, owner);
          if (!winCard || winCard.suit === SUBMARINE || winCard.value !== p.winValue) return false;
          return t.plays.some((pl) => pl.card.suit !== SUBMARINE && pl.card.value === p.capturedValue);
        });
      case 'trickContainsCountOfNumber':
        return this.tricks.some((t) => t.winnerSeat === owner && t.plays.filter((pl) => pl.card.suit !== SUBMARINE && pl.card.value === p.value).length >= p.count);
      case 'acquireSpecificCard': return this._wonCards(owner).some((c) => c.suit === p.suit && c.value === p.value);
      case 'acquireAllOfNumber': return COLOR_SUITS.every((suit) => this._wonCards(owner).some((c) => c.suit === suit && c.value === p.value));
      case 'acquireAtLeastOfNumber': return this._numberCount(owner, p.value) >= p.count;
      case 'acquireExactlyOfNumber': return this._numberCount(owner, p.value) === p.count;
      case 'acquireMultipleSpecificCards': return p.cards.every((card) => this._wonCards(owner).some((c) => c.suit === card.suit && c.value === card.value));
      case 'acquireSpecificCardInTrick': {
        const targetIdx = p.trick === 'last' ? LAST_TRICK_INDEX[this.numPlayers] : p.trick;
        const trick = this.tricks.find((t) => t.trickIndex === targetIdx);
        return !!trick && trick.winnerSeat === owner && trick.plays.some((pl) => pl.card.suit === p.suit && pl.card.value === p.value);
      }
      case 'colorCountExactMulti': return Object.entries(p.counts).every(([suit, cnt]) => this._colorCount(owner, suit) === cnt);
      case 'colorCountAtLeast': return this._colorCount(owner, p.suit) >= p.count;
      case 'colorCountExact': return this._colorCount(owner, p.suit) === p.count;
      case 'acquireAtLeastOnePerColorAll': return COLOR_SUITS.every((suit) => this._colorCount(owner, suit) >= 1);
      case 'acquireFullRunOneColor':
        return COLOR_SUITS.some((suit) => { for (let v = 1; v <= 9; v++) { if (!this._wonCards(owner).some((c) => c.suit === suit && c.value === v)) return false; } return true; });
      case 'trickAllValuesEven':
        return this.tricks.some((t) => t.winnerSeat === owner && !t.plays.some((pl) => pl.card.suit === SUBMARINE) && t.plays.every((pl) => pl.card.value % 2 === 0));
      case 'trickAllValuesOdd':
        return this.tricks.some((t) => t.winnerSeat === owner && !t.plays.some((pl) => pl.card.suit === SUBMARINE) && t.plays.every((pl) => pl.card.value % 2 === 1));
      case 'trickColorSumOver': {
        const th = p.threshold[this.numPlayers];
        return this.tricks.some((t) => t.winnerSeat === owner && !t.plays.some((pl) => pl.card.suit === SUBMARINE) && t.plays.reduce((a, pl) => a + pl.card.value, 0) > th);
      }
      case 'trickColorSumUnder': {
        const th = p.threshold[this.numPlayers];
        return this.tricks.some((t) => t.winnerSeat === owner && !t.plays.some((pl) => pl.card.suit === SUBMARINE) && t.plays.reduce((a, pl) => a + pl.card.value, 0) < th);
      }
      case 'trickColorSumIn':
        return this.tricks.some((t) => t.winnerSeat === owner && !t.plays.some((pl) => pl.card.suit === SUBMARINE) && p.values.includes(t.plays.reduce((a, pl) => a + pl.card.value, 0)));
      case 'submarineCountExact': return this._submarineCount(owner) === p.count;
      case 'submarineExactAndOnly': return this._hasSubmarineValue(owner, p.mainValue) && this._submarineCount(owner) === 1;
      case 'winSubmarineTrickWithCard':
        return this.tricks.some((t) => {
          if (t.winnerSeat !== owner) return false;
          const winCard = this._cardOfSeatInTrick(t, owner);
          if (!winCard || winCard.suit !== SUBMARINE) return false;
          return t.plays.some((pl) => pl.card.suit === p.suit && pl.card.value === p.value);
        });
      case 'neverLeadWithSuits': return !this.tricks.some((t) => t.leaderSeat === owner && p.suits.includes(t.leadSuit));
      case 'numberCountExact': return this._numberCount(owner, p.value) === p.count;
      case 'numberCountExactMulti': return Object.entries(p.counts).every(([val, cnt]) => this._numberCount(owner, Number(val)) === cnt);
      case 'noTricksInRange': return !this._wonTrickIndexes(owner).some((i) => i >= p.from && i <= p.to);
      case 'noTricksAtAll': return this._wonTrickIndexes(owner).length === 0;
      case 'neverConsecutiveTricks': return this._consecutiveRuns(owner).every((len) => len < 2);
      case 'winSpecificTrick': { const target = p.trick === 'last' ? LAST_TRICK_INDEX[this.numPlayers] : p.trick; return this._wonTrickIndexes(owner).includes(target); }
      case 'winTricks': { const targets = p.tricks.map((tt) => (tt === 'last' ? LAST_TRICK_INDEX[this.numPlayers] : tt)); return targets.every((t) => this._wonTrickIndexes(owner).includes(t)); }
      case 'winOnlyTrick': {
        const target = p.trick === 'last' ? LAST_TRICK_INDEX[this.numPlayers] : p.trick;
        const won = this._wonTrickIndexes(owner);
        return won.includes(target) && won.every((i) => i === target);
      }
      case 'winExactlyNTricks': return this._wonTrickIndexes(owner).length === p.n;
      case 'consecutiveAtLeast': return this._consecutiveRuns(owner).some((len) => len >= p.n);
      case 'consecutiveExactRun': return this._consecutiveRuns(owner).some((len) => len === p.n);
      case 'predictTrickCountOpen':
      case 'predictTrickCountSecret': { const pred = this.predictions[task.id]; if (!pred) return false; return this._wonTrickIndexes(owner).length === pred.value; }
      case 'colorCountEqualEndOfMission': { const a = this._colorCount(owner, p.suitA); const b = this._colorCount(owner, p.suitB); return a === b && a >= (p.minEach || 0) && b >= (p.minEach || 0); }
      case 'colorCountEqualInSingleTrick':
        return this.tricks.some((t) => {
          if (t.winnerSeat !== owner) return false;
          const a = t.plays.filter((pl) => pl.card.suit === p.suitA).length;
          const b = t.plays.filter((pl) => pl.card.suit === p.suitB).length;
          return a === b && a >= (p.minEach || 0) && b >= (p.minEach || 0);
        });
      case 'colorCountGreaterEndOfMission': return this._colorCount(owner, p.suitA) > this._colorCount(owner, p.suitB);
      default: return false;
    }
  }

  _seatLabel(seat) { const s = this.seats[seat]; return s && s.name ? s.name : `좌석${seat + 1}`; }

  getStateFor(viewerSeat) {
    const previousTrick = this.tricks.length > 0 ? this.tricks[this.tricks.length - 1] : null;
    const base = {
      gameType: 'crew',
      numPlayers: this.numPlayers,
      options: this.options,
      seats: this.seats,
      phase: this.phase,
      missionNumber: this.missionNumber,
      missionDifficulty: this.missionDifficulty,
      missionModifiers: this.missionModifiers,
      missionDeadlineAt: this.missionDeadlineAt,
      attemptNumber: this.attemptNumber,
      failedAttemptsThisMission: this.failedAttemptsThisMission,
      captainSeat: this.captainSeat,
      taskPool: this.taskPool.map((id) => {
        const task = TASKS_BY_ID[id];
        const owner = this.taskAssignment[id] ?? null;
        let status = 'pending';
        if (owner !== null && this.hands) {
          if (this.phase === 'missionEnd') status = this._isTaskSatisfiedFinal(task, owner) ? 'success' : 'fail';
          else if (IMMEDIATE_FAIL_TYPES.has(task.type) && this._isImmediateFail(task, owner)) status = 'fail';
          else if (EARLY_SUCCESS_TYPES.has(task.type) && this._isTaskSatisfiedFinal(task, owner)) status = 'success';
        }
        return { ...task, id, owner, status };
      }),
      unassignedTasks: this.unassignedTasks,
      currentTaskSelector: this.currentTaskSelector(),
      canPassTaskSelection: this.canPassTaskSelection(),
      rescue: this.rescue,
      pendingPredictionTasks: this.pendingPredictionTasks,
      predictions: Object.fromEntries(Object.entries(this.predictions).map(([k, v]) => [k, v.secret && !v.revealed ? { secret: true } : v])),
      tricks: this.tricks,
      previousTrick,
      currentTrick: this.currentTrick,
      currentPlayerToAct: this.currentPlayerToAct(),
      nextLeader: this.nextLeader,
      handCounts: this.hands ? this.hands.map((h) => h.length) : null,
      comm: this.comm || {},
      missionResult: this.missionResult,
      lastTrickIndex: LAST_TRICK_INDEX[this.numPlayers],
      log: this.log.slice(-40),
      removedCardKnown: this.removedFromSeat === viewerSeat ? this.removedCard : (this.removedFromSeat !== null),
    };
    base.myHand = viewerSeat !== null && this.hands ? this.hands[viewerSeat] : null;
    if (this.phase === 'missionEnd') base.reveal = { hands: this.hands, predictions: this.predictions };
    return base;
  }

  // ---- 좌석/플레이어 배정 (Firebase 로비용) ----
  assignSeat(seat, playerId, name) {
    if (seat < 0 || seat >= this.numPlayers) throw new Error('잘못된 좌석입니다.');
    this.seats[seat].playerId = playerId;
    this.seats[seat].name = name;
  }
  seatOfPlayer(playerId) {
    const s = this.seats.find((x) => x.playerId === playerId);
    return s ? s.seat : -1;
  }

  // ---- 전체 상태 직렬화 (Firebase 저장/복원용) ----
  // 클래스 인스턴스를 통째로 평범한 객체로 저장했다가 그대로 되살린다.
  toJSON() {
    return {
      numPlayers: this.numPlayers,
      options: this.options,
      seats: this.seats,
      log: this.log,
      taskDeck: this.taskDeck,
      missionNumber: this.missionNumber,
      attemptNumber: this.attemptNumber,
      failedAttemptsThisMission: this.failedAttemptsThisMission,
      phase: this.phase,
      hands: this.hands,
      removedCard: this.removedCard,
      removedFromSeat: this.removedFromSeat,
      captainSeat: this.captainSeat,
      taskPool: this.taskPool,
      taskAssignment: this.taskAssignment,
      taskOwnerPasses: Array.from(this.taskOwnerPasses || []),
      taskSelectionOrder: this.taskSelectionOrder,
      taskSelectionTurnIdx: this.taskSelectionTurnIdx,
      taskSelectionCycleStartCount: this.taskSelectionCycleStartCount,
      tricks: this.tricks,
      currentTrick: this.currentTrick,
      nextLeader: this.nextLeader,
      comm: this.comm,
      rescue: this.rescue,
      predictions: this.predictions,
      missionResult: this.missionResult,
      missionDifficulty: this.missionDifficulty,
      pendingPredictionTasks: this.pendingPredictionTasks,
      _taskSelectionRestartGuard: this._taskSelectionRestartGuard,
      missionModifiers: this.missionModifiers,
      missionDeadlineAt: this.missionDeadlineAt,
      timeExpired: this.timeExpired,
    };
  }

  static fromJSON(data) {
    const g = new Game(data.numPlayers, data.options || {});
    Object.assign(g, data);
    g.taskOwnerPasses = new Set(data.taskOwnerPasses || []);
    if (!g.taskAssignment) g.taskAssignment = {};
    if (!g.comm) g.comm = {};
    if (!g.predictions) g.predictions = {};
    // Firebase는 빈 객체/배열을 저장하며 삭제하므로 복구한다.
    if (g.rescue) {
      g.rescue.directionChoice = g.rescue.directionChoice || {};
      g.rescue.passChoice = g.rescue.passChoice || {};
      g.rescue.cardsGiven = g.rescue.cardsGiven || {};
    }
    if (!g.taskPool) g.taskPool = [];
    if (!g.tricks) g.tricks = [];
    if (!g.pendingPredictionTasks) g.pendingPredictionTasks = [];
    if (!g.log) g.log = [];
    if (!g.seats) g.seats = [];
    return g;
  }
}

export { Game, TASKS_BY_ID, LAST_TRICK_INDEX };

