const express = require('express');
const { createClient } = require('redis');
const path = require('path');

const app = express();
const port = 8090;

app.use(express.json());
app.use(express.static('public'));

// Redis kliens inicializálása
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});
redisClient.connect().catch(console.error);

// Játékállapot inicializálása
function initializeGameState() {
  return {
    boards: Array(9).fill(null).map(() => Array(9).fill(null)),
    boardWinners: Array(9).fill(null),
    activeBoard: -1, // -1: bárhol lehet játszani
    turn: "X",     // Mindig X jellel kezdődik a játék
    players: {},   // { X: <playerId>, O: <playerId> }
    createdAt: Date.now(),
    expiresAt: Date.now() + 60 * 60 * 1000 // 1 óra érvényesség
  };
}

// Overall nyertes ellenőrzése
function checkOverallWinner(boardWinners) {
  const combos = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];
  for (let combo of combos) {
    if (
      boardWinners[combo[0]] &&
      boardWinners[combo[0]] === boardWinners[combo[1]] &&
      boardWinners[combo[1]] === boardWinners[combo[2]]
    ) {
      return boardWinners[combo[0]];
    }
  }
  return null;
}

// Új session létrehozása (5 számjegyű session ID)
app.post('/api/new-session', async (req, res) => {
  const sessionId = Math.floor(10000 + Math.random() * 90000).toString();
  const gameState = initializeGameState();
  // Ha a local=true paraméter szerepel, állítsuk be a játékosokat alapértelmezetten
  if (req.query.local === 'true') {
    gameState.players = { X: "X", O: "O" };
  }
  await redisClient.set(sessionId, JSON.stringify(gameState), { EX: 3600 });
  res.json({ sessionId });
});

// Játékállapot lekérése
app.get('/api/session/:sessionId/state', async (req, res) => {
  const sessionId = req.params.sessionId;
  const stateStr = await redisClient.get(sessionId);
  if (!stateStr) {
    return res.status(404).json({ error: "A session nem található vagy lejárt" });
  }
  const state = JSON.parse(stateStr);
  res.json(state);
});

// Léptetés leadása
app.post('/api/session/:sessionId/move', async (req, res) => {
  const sessionId = req.params.sessionId;
  const { boardIndex, cellIndex, symbol } = req.body;

  if (boardIndex < 0 || boardIndex > 8 || cellIndex < 0 || cellIndex > 8 || (symbol !== 'X' && symbol !== 'O')) {
    return res.status(400).json({ error: "Érvénytelen lépés paraméterek" });
  }

  const stateStr = await redisClient.get(sessionId);
  if (!stateStr) {
    return res.status(404).json({ error: "A session nem található vagy lejárt" });
  }
  let state = JSON.parse(stateStr);

  if (state.overallWinner) {
    return res.status(400).json({ error: "A játék már véget ért" });
  }

  if (state.turn !== symbol) {
    return res.status(400).json({ error: "Nem az Ön köre" });
  }

  if (state.activeBoard !== -1 && boardIndex !== state.activeBoard) {
    return res.status(400).json({ error: "Ezen a mini táblán nem lehet lépni" });
  }
  
  if (state.boards[boardIndex][cellIndex]) {
    return res.status(400).json({ error: "Ez a mező már foglalt" });
  }

  state.boards[boardIndex][cellIndex] = symbol;

  const board = state.boards[boardIndex];
  const winningCombos = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];
  for (let combo of winningCombos) {
    if (board[combo[0]] && board[combo[0]] === board[combo[1]] && board[combo[1]] === board[combo[2]]) {
      state.boardWinners[boardIndex] = board[combo[0]];
      break;
    }
  }

  let nextActive = cellIndex;
  const nextBoard = state.boards[nextActive];
  const isBoardFull = nextBoard.every(cell => cell !== null);
  if (state.boardWinners[nextActive] || isBoardFull) {
    state.activeBoard = -1;
  } else {
    state.activeBoard = nextActive;
  }

  state.turn = (state.turn === 'X') ? 'O' : 'X';

  const overallWinner = checkOverallWinner(state.boardWinners);
  if (overallWinner) {
    state.overallWinner = overallWinner;
    state.activeBoard = -2;
  }

  await redisClient.set(sessionId, JSON.stringify(state), { EX: 3600 });
  res.json(state);
});

// Visszaszámláló lekérése
app.get('/api/session/:sessionId/timer', async (req, res) => {
  const sessionId = req.params.sessionId;
  const stateStr = await redisClient.get(sessionId);
  if (!stateStr) {
    return res.status(404).json({ error: "A session nem található vagy lejárt" });
  }
  const state = JSON.parse(stateStr);
  const remainingMs = state.expiresAt - Date.now();
  res.json({ remainingMs: remainingMs > 0 ? remainingMs : 0 });
});

// Szimbólum választás (automatikus kiosztás: első játékos X, második O)
app.post('/api/session/:sessionId/select-symbol', async (req, res) => {
  const sessionId = req.params.sessionId;
  const { playerId } = req.body;
  const stateStr = await redisClient.get(sessionId);
  if (!stateStr) {
    return res.status(404).json({ error: "A session nem található vagy lejárt" });
  }
  let state = JSON.parse(stateStr);
  if (!state.players) {
    state.players = {};
  }

  if (state.players.X === playerId) {
    return res.json({ assignedSymbol: "X" });
  }
  if (state.players.O === playerId) {
    return res.json({ assignedSymbol: "O" });
  }

  if (!state.players.X && !state.players.O) {
    state.players.X = playerId;
  } else if (state.players.X && !state.players.O) {
    state.players.O = playerId;
  } else if (!state.players.X && state.players.O) {
    state.players.X = playerId;
  } else {
    return res.status(400).json({ error: "Mindkét szimbólum már foglalt" });
  }

  await redisClient.set(sessionId, JSON.stringify(state), { EX: 3600 });
  res.json({ assignedSymbol: state.players.X === playerId ? "X" : "O", state });
});

// Új játék indítása a sessionben
app.post('/api/session/:sessionId/new-game', async (req, res) => {
  const sessionId = req.params.sessionId;
  const stateStr = await redisClient.get(sessionId);
  if (!stateStr) {
    return res.status(404).json({ error: "A session nem található vagy lejárt" });
  }
  let state = JSON.parse(stateStr);
  state.boards = Array(9).fill(null).map(() => Array(9).fill(null));
  state.boardWinners = Array(9).fill(null);
  state.activeBoard = -1;
  state.turn = "X";
  delete state.overallWinner;
  state.createdAt = Date.now();
  state.expiresAt = Date.now() + 60 * 60 * 1000;
  await redisClient.set(sessionId, JSON.stringify(state), { EX: 3600 });
  res.json(state);
});

// Játékosok szimbólumainak megcserélése
app.post('/api/session/:sessionId/swap-symbols', async (req, res) => {
  const sessionId = req.params.sessionId;
  const stateStr = await redisClient.get(sessionId);
  if (!stateStr) {
    return res.status(404).json({ error: "A session nem található vagy lejárt" });
  }
  let state = JSON.parse(stateStr);
  if (!state.players || (!state.players.X && !state.players.O)) {
    return res.status(400).json({ error: "A játékosok nincsenek még hozzárendelve" });
  }
  // Szimbólumok cseréje
  const temp = state.players.X;
  state.players.X = state.players.O;
  state.players.O = temp;
  // Kényszerítjük, hogy a swap után a kezdő turn legyen X
  state.turn = "X";
  await redisClient.set(sessionId, JSON.stringify(state), { EX: 3600 });
  res.json({ swapped: true, state });
});

// Útvonal a game.html kiszolgálásához
app.get('/:sessionId', (req, res, next) => {
  if (req.params.sessionId.startsWith('api')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

app.listen(port, () => {
  console.log(`Ultimate Tic Tac Toe szerver fut a ${port} porton`);
});
