'use strict';
const COLOR_SUITS = ['PINK', 'BLUE', 'GREEN', 'YELLOW'];
const SUBMARINE = 'SUBMARINE';
const ALL_SUITS = [...COLOR_SUITS, SUBMARINE];

function cardId(card) { return `${card.suit}${card.value}`; }

function buildDeck() {
  const deck = [];
  for (const suit of COLOR_SUITS) { for (let v = 1; v <= 9; v++) deck.push({ suit, value: v }); }
  for (let v = 1; v <= 4; v++) deck.push({ suit: SUBMARINE, value: v });
  return deck;
}

function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sortHand(hand) {
  const order = { PINK: 0, BLUE: 1, GREEN: 2, YELLOW: 3, SUBMARINE: 4 };
  return hand.slice().sort((a, b) => {
    if (order[a.suit] !== order[b.suit]) return order[a.suit] - order[b.suit];
    return a.value - b.value;
  });
}

function dealCards(deck, numPlayers) {
  let workingDeck = deck;
  let removedCard = null;
  let removedFromSeat = null;

  if (numPlayers === 3) {
    const idx = deck.findIndex((c) => c.suit === SUBMARINE && c.value === 4);
    if (idx !== -1) {
      removedCard = deck[idx];
      workingDeck = deck.slice(0, idx).concat(deck.slice(idx + 1));
    }
  }

  const hands = Array.from({ length: numPlayers }, () => []);
  workingDeck.forEach((card, idx) => { hands[idx % numPlayers].push(card); });
  return { hands: hands.map(sortHand), removedCard, removedFromSeat };
}

function findCaptainSeat(hands, numPlayers) {
  const captainValue = numPlayers === 3 ? 3 : 4;
  for (let i = 0; i < hands.length; i++) {
    if (hands[i].some((c) => c.suit === SUBMARINE && c.value === captainValue)) return i;
  }
  return -1;
}

export { COLOR_SUITS, SUBMARINE, ALL_SUITS, cardId, buildDeck, shuffle, sortHand, dealCards, findCaptainSeat };
