const express = require('express');
const { createClient } = require('redis');
const path = require('path');

const app = express();

const port = Number(process.env.PORT || 8090);
const redisUrl = process.env.REDIS_URL || 'redis://redis-service:6379';
const redisKeyPrefix = process.env.REDIS_KEY_PREFIX || 'ttt:session';
const sessionTtlSeconds = Number(process.env.SESSION_TTL_SECONDS || 3600);

function normalizeBasePath(value) {
  if (!value || value === '/') return '';
  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`;
  return withLeadingSlash.replace(/\/+$/, '');
}

const basePath = normalizeBasePath(process.env.BASE_PATH || '/tic-tac-toe');

app.use(express.json());

const redisClient = createClient({
  url: redisUrl,
});

redisClient.on('error', (err) => {
  console.error('Redis client error:', err);
});

redisClient.connect().catch((err) => {
  console.error('Redis connection error:', err);
});

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function sessionKey(sessionId) {
  return `${redisKeyPrefix}:${sessionId}`;
}

function legacySessionKey(sessionId) {
  return sessionId;
}

function lockKey(sessionId) {
  return `${redisKeyPrefix}:${sessionId}:lock`;
}

function safeJsonParse(raw, fallback = null) {
  if (!raw) return fallback;

  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function getSessionState(sessionId) {
  const raw =
    (await redisClient.get(sessionKey(sessionId))) ||
    (await redisClient.get(legacySessionKey(sessionId)));

  return safeJsonParse(raw, null);
}

async function saveSessionState(sessionId, state) {
  await redisClient.set(sessionKey(sessionId), JSON.stringify(state), {
    EX: sessionTtlSeconds,
  });
}

async function withSessionLock(sessionId, action) {
  const key = lockKey(sessionId);
  const token = `${process.pid}-${Date.now()}-${Math.random()}`;

  const locked = await redisClient.set(key, token, {
    NX: true,
    EX: 10,
  });

  if (!locked) {
    throw httpError(409, 'A session éppen módosítás alatt van, próbáld újra.');
  }

  try {
    return await action();
  } finally {
    const current = await redisClient.get(key);
    if (current === token) {
      await redisClient.del(key);
    }
  }
}

function randomSessionId() {
  return Math.floor(10000 + Math.random() * 90000).toString();
}

function initializeGameState() {
  return {
    boards: Array(9)
      .fill(null)
      .map(() => Array(9).fill(null)),
    boardWinners: Array(9).fill(null),
    activeBoard: -1,
    turn: 'X',
    players: {},
    createdAt: Date.now(),
    expiresAt: Date.now() + sessionTtlSeconds * 1000,
  };
}

function checkMiniBoardWinner(board) {
  const winningCombos = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];

  for (const combo of winningCombos) {
    const [a, b, c] = combo;

    if (board[a] && board[a] === board[b] && board[b] === board[c]) {
      return board[a];
    }
  }

  return null;
}

function checkOverallWinner(boardWinners) {
  const combos = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];

  for (const combo of combos) {
    const [a, b, c] = combo;

    if (
      boardWinners[a] &&
      boardWinners[a] === boardWinners[b] &&
      boardWinners[b] === boardWinners[c]
    ) {
      return boardWinners[a];
    }
  }

  return null;
}

async function createSession({ local = false } = {}) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const sessionId = randomSessionId();
    const gameState = initializeGameState();

    if (local) {
      gameState.players = {
        X: 'X',
        O: 'O',
      };
    }

    const result = await redisClient.set(sessionKey(sessionId), JSON.stringify(gameState), {
      EX: sessionTtlSeconds,
      NX: true,
    });

    if (result === 'OK') {
      return { sessionId };
    }
  }

  throw httpError(503, 'Nem sikerült egyedi session ID-t létrehozni');
}

async function healthHandler(req, res) {
  try {
    await redisClient.ping();

    res.json({
      ok: true,
      redis: 'ok',
      basePath,
      redisKeyPrefix,
    });
  } catch (err) {
    console.error('Health check failed:', err);

    res.status(500).json({
      ok: false,
      redis: 'error',
    });
  }
}

app.get('/healthz', healthHandler);

app.use(basePath, express.static('public', { index: 'index.html' }));

app.get(basePath + '/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post(basePath + '/api/new-session', async (req, res) => {
  try {
    const session = await createSession({
      local: req.query.local === 'true',
    });

    res.json(session);
  } catch (err) {
    console.error('Session creation error:', err);

    res.status(err.statusCode || 500).json({
      error: err.message || 'Server error',
    });
  }
});

app.get(basePath + '/api/session/:sessionId/state', async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const state = await getSessionState(sessionId);

    if (!state) {
      return res.status(404).json({
        error: 'A session nem található vagy lejárt',
      });
    }

    res.json(state);
  } catch (err) {
    console.error('State read error:', err);

    res.status(500).json({
      error: 'Server error',
    });
  }
});

app.post(basePath + '/api/session/:sessionId/move', async (req, res) => {
  const sessionId = req.params.sessionId;

  try {
    const result = await withSessionLock(sessionId, async () => {
      const { boardIndex, cellIndex, symbol } = req.body;

      if (
        boardIndex < 0 ||
        boardIndex > 8 ||
        cellIndex < 0 ||
        cellIndex > 8 ||
        (symbol !== 'X' && symbol !== 'O')
      ) {
        throw httpError(400, 'Érvénytelen lépés paraméterek');
      }

      const state = await getSessionState(sessionId);

      if (!state) {
        throw httpError(404, 'A session nem található vagy lejárt');
      }

      if (state.overallWinner) {
        throw httpError(400, 'A játék már véget ért');
      }

      if (state.turn !== symbol) {
        throw httpError(400, 'Nem az Ön köre');
      }

      if (state.activeBoard !== -1 && boardIndex !== state.activeBoard) {
        throw httpError(400, 'Ezen a mini táblán nem lehet lépni');
      }

      if (state.boards[boardIndex][cellIndex]) {
        throw httpError(400, 'Ez a mező már foglalt');
      }

      state.boards[boardIndex][cellIndex] = symbol;

      const miniWinner = checkMiniBoardWinner(state.boards[boardIndex]);
      if (miniWinner) {
        state.boardWinners[boardIndex] = miniWinner;
      }

      const nextActive = cellIndex;
      const nextBoard = state.boards[nextActive];
      const isBoardFull = nextBoard.every((cell) => cell !== null);

      if (state.boardWinners[nextActive] || isBoardFull) {
        state.activeBoard = -1;
      } else {
        state.activeBoard = nextActive;
      }

      state.turn = state.turn === 'X' ? 'O' : 'X';

      const overallWinner = checkOverallWinner(state.boardWinners);
      if (overallWinner) {
        state.overallWinner = overallWinner;
        state.activeBoard = -2;
      }

      state.expiresAt = Date.now() + sessionTtlSeconds * 1000;

      await saveSessionState(sessionId, state);

      return state;
    });

    res.json(result);
  } catch (err) {
    console.error('Move error:', err);

    res.status(err.statusCode || 500).json({
      error: err.message || 'Server error',
    });
  }
});

app.get(basePath + '/api/session/:sessionId/timer', async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const state = await getSessionState(sessionId);

    if (!state) {
      return res.status(404).json({
        error: 'A session nem található vagy lejárt',
      });
    }

    const remainingMs = state.expiresAt - Date.now();

    res.json({
      remainingMs: remainingMs > 0 ? remainingMs : 0,
    });
  } catch (err) {
    console.error('Timer error:', err);

    res.status(500).json({
      error: 'Server error',
    });
  }
});

app.post(basePath + '/api/session/:sessionId/select-symbol', async (req, res) => {
  const sessionId = req.params.sessionId;

  try {
    const result = await withSessionLock(sessionId, async () => {
      const { playerId } = req.body;

      if (!playerId) {
        throw httpError(400, 'Hiányzó playerId');
      }

      const state = await getSessionState(sessionId);

      if (!state) {
        throw httpError(404, 'A session nem található vagy lejárt');
      }

      if (!state.players) {
        state.players = {};
      }

      if (state.players.X === playerId) {
        return { assignedSymbol: 'X' };
      }

      if (state.players.O === playerId) {
        return { assignedSymbol: 'O' };
      }

      if (!state.players.X && !state.players.O) {
        state.players.X = playerId;
      } else if (state.players.X && !state.players.O) {
        state.players.O = playerId;
      } else if (!state.players.X && state.players.O) {
        state.players.X = playerId;
      } else {
        throw httpError(400, 'Mindkét szimbólum már foglalt');
      }

      state.expiresAt = Date.now() + sessionTtlSeconds * 1000;

      await saveSessionState(sessionId, state);

      return {
        assignedSymbol: state.players.X === playerId ? 'X' : 'O',
        state,
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Select symbol error:', err);

    res.status(err.statusCode || 500).json({
      error: err.message || 'Server error',
    });
  }
});

app.post(basePath + '/api/session/:sessionId/new-game', async (req, res) => {
  const sessionId = req.params.sessionId;

  try {
    const result = await withSessionLock(sessionId, async () => {
      const state = await getSessionState(sessionId);

      if (!state) {
        throw httpError(404, 'A session nem található vagy lejárt');
      }

      state.boards = Array(9)
        .fill(null)
        .map(() => Array(9).fill(null));
      state.boardWinners = Array(9).fill(null);
      state.activeBoard = -1;
      state.turn = 'X';
      delete state.overallWinner;
      state.createdAt = Date.now();
      state.expiresAt = Date.now() + sessionTtlSeconds * 1000;

      await saveSessionState(sessionId, state);

      return state;
    });

    res.json(result);
  } catch (err) {
    console.error('New game error:', err);

    res.status(err.statusCode || 500).json({
      error: err.message || 'Server error',
    });
  }
});

app.post(basePath + '/api/session/:sessionId/swap-symbols', async (req, res) => {
  const sessionId = req.params.sessionId;

  try {
    const result = await withSessionLock(sessionId, async () => {
      const state = await getSessionState(sessionId);

      if (!state) {
        throw httpError(404, 'A session nem található vagy lejárt');
      }

      if (!state.players || (!state.players.X && !state.players.O)) {
        throw httpError(400, 'A játékosok nincsenek még hozzárendelve');
      }

      const temp = state.players.X;
      state.players.X = state.players.O;
      state.players.O = temp;
      state.turn = 'X';
      state.expiresAt = Date.now() + sessionTtlSeconds * 1000;

      await saveSessionState(sessionId, state);

      return {
        swapped: true,
        state,
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Swap symbols error:', err);

    res.status(err.statusCode || 500).json({
      error: err.message || 'Server error',
    });
  }
});

app.get(basePath + '/:sessionId', (req, res, next) => {
  if (req.params.sessionId.startsWith('api')) {
    return next();
  }

  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

app.get('/', (req, res) => {
  res.redirect(basePath + '/');
});

app.listen(port, () => {
  console.log(`Ultimate Tic Tac Toe server running on port ${port}`);
  console.log(`Base path: ${basePath}`);
  console.log(`Redis URL: ${redisUrl}`);
  console.log(`Redis key prefix: ${redisKeyPrefix}`);
});
