const express = require('express');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');
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

// Ellenőrzi a nagytábla győzelmi feltételeit (3 mini tábla egymás mellett)
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
  await redisClient.set(sessionId, JSON.stringify(gameState), { EX: 3600 });
  res.json({ sessionId });
});

// Játékállapot lekérése
app.get('/api/session/:sessionId/state', async (req, res) => {
  const sessionId = req.params.sessionId;
  const stateStr = await redisClient.get(sessionId);
  if (!stateStr) {
    return res.status(404).json({ error: "Session not found or expired" });
  }
  const state = JSON.parse(stateStr);
  res.json(state);
});

// Léptetés leadása
app.post('/api/session/:sessionId/move', async (req, res) => {
  const sessionId = req.params.sessionId;
  const { boardIndex, cellIndex, symbol } = req.body;

  if (boardIndex < 0 || boardIndex > 8 || cellIndex < 0 || cellIndex > 8 || (symbol !== 'X' && symbol !== 'O')) {
    return res.status(400).json({ error: "Invalid move parameters" });
  }

  const stateStr = await redisClient.get(sessionId);
  if (!stateStr) {
    return res.status(404).json({ error: "Session not found or expired" });
  }
  let state = JSON.parse(stateStr);

  // Ha a játék már véget ért, ne lehessen lépni
  if (state.overallWinner) {
    return res.status(400).json({ error: "Game is already over" });
  }

  if (state.turn !== symbol) {
    return res.status(400).json({ error: "Not your turn" });
  }

  // Ha van aktív mini tábla, csak arra lehet lépni
  if (state.activeBoard !== -1 && boardIndex !== state.activeBoard) {
    return res.status(400).json({ error: "Move not allowed in this board" });
  }
  
  // Ellenőrizzük, hogy az adott cella üres-e
  if (state.boards[boardIndex][cellIndex]) {
    return res.status(400).json({ error: "Cell already occupied" });
  }

  // Léptetés végrehajtása
  state.boards[boardIndex][cellIndex] = symbol;

  // Mini tábla nyerés ellenőrzése
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

  // Következő aktív mini tábla meghatározása
  let nextActive = cellIndex;
  const nextBoard = state.boards[nextActive];
  const isBoardFull = nextBoard.every(cell => cell !== null);
  if (state.boardWinners[nextActive] || isBoardFull) {
    state.activeBoard = -1; // szabad választás
  } else {
    state.activeBoard = nextActive;
  }

  // Kör váltás
  state.turn = (state.turn === 'X') ? 'O' : 'X';

  // Ellenőrizzük, hogy van-e overall győztes
  const overallWinner = checkOverallWinner(state.boardWinners);
  if (overallWinner) {
    state.overallWinner = overallWinner;
    state.activeBoard = -2; // speciális marker a játék vége jelzésére
  }

  await redisClient.set(sessionId, JSON.stringify(state), { EX: 3600 });
  res.json(state);
});

// Visszaszámláló idő lekérése
app.get('/api/session/:sessionId/timer', async (req, res) => {
  const sessionId = req.params.sessionId;
  const stateStr = await redisClient.get(sessionId);
  if (!stateStr) {
    return res.status(404).json({ error: "Session not found or expired" });
  }
  const state = JSON.parse(stateStr);
  const remainingMs = state.expiresAt - Date.now();
  res.json({ remainingMs: remainingMs > 0 ? remainingMs : 0 });
});

// Szimbólum választás (automatikus kiosztás: az első játékos mindig X, a második O)
app.post('/api/session/:sessionId/select-symbol', async (req, res) => {
  const sessionId = req.params.sessionId;
  const { playerId } = req.body;
  const stateStr = await redisClient.get(sessionId);
  if (!stateStr) {
    return res.status(404).json({ error: "Session not found or expired" });
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
    return res.status(400).json({ error: "Both symbols already taken" });
  }

  await redisClient.set(sessionId, JSON.stringify(state), { EX: 3600 });
  res.json({ assignedSymbol: state.players.X === playerId ? "X" : "O", state });
});

// Új játék indítása (a táblák ürítése, overallWinner törlése, X kezdéssel)
app.post('/api/session/:sessionId/new-game', async (req, res) => {
  const sessionId = req.params.sessionId;
  const stateStr = await redisClient.get(sessionId);
  if (!stateStr) {
    return res.status(404).json({ error: "Session not found or expired" });
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
    return res.status(404).json({ error: "Session not found or expired" });
  }
  let state = JSON.parse(stateStr);
  if (!state.players || (!state.players.X && !state.players.O)) {
    return res.status(400).json({ error: "Players not assigned yet" });
  }
  const temp = state.players.X;
  state.players.X = state.players.O;
  state.players.O = temp;
  state.turn = (state.turn === 'X' ? 'O' : 'X');
  await redisClient.set(sessionId, JSON.stringify(state), { EX: 3600 });
  res.json({ swapped: true, state });
});

// Útvonal a game.html kiszolgálásához – a sessionId közvetlenül a gyökér után szerepel
app.get('/:sessionId', (req, res, next) => {
  if (req.params.sessionId.startsWith('api')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

app.listen(port, () => {
  console.log(`Ultimate Tic Tac Toe server listening on port ${port}`);
});
