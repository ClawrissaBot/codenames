import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { WORDS } from './words';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── Word Sets ──────────────────────────────────────────────────────────────

const wordSets: Record<string, string[]> = { 'English (Original)': WORDS };

// Load additional word sets from words.json if available
try {
  const wordsJsonPath = path.join(__dirname, '../../frontend/words.json');
  if (fs.existsSync(wordsJsonPath)) {
    const extra = JSON.parse(fs.readFileSync(wordsJsonPath, 'utf-8'));
    for (const [lang, words] of Object.entries(extra)) {
      if (Array.isArray(words) && words.length >= 25) {
        wordSets[lang] = words as string[];
      }
    }
  }
} catch {}

// ─── Types ──────────────────────────────────────────────────────────────────

interface Card { id: number; word: string; type: 'red' | 'blue' | 'neutral' | 'assassin'; revealed: boolean; }
interface Player { id: string; name: string; ws: WebSocket; team: 'red' | 'blue' | null; role: 'spymaster' | 'operative' | null; }
interface GameState {
  roomId: string;
  players: Record<string, Player>;
  board: Card[];
  currentTurn: 'red' | 'blue';
  winner: 'red' | 'blue' | null;
  log: string[];
  redLeft: number;
  blueLeft: number;
  clue: { word: string; count: number } | null;
  timerDurationMs: number;
  enforceTimer: boolean;
  roundStartedAt: number;
  wordSet: string[];
  createdAt: number;
}

const rooms: Record<string, GameState> = {};

// ─── Persistence ────────────────────────────────────────────────────────────

const STORE_PATH = path.join(__dirname, '../../.game-store.json');

function saveStore() {
  try {
    // Serialize rooms without WebSocket references
    const serializable: Record<string, any> = {};
    for (const [id, room] of Object.entries(rooms)) {
      serializable[id] = {
        ...room,
        players: Object.fromEntries(
          Object.entries(room.players).map(([pid, p]) => [pid, { id: p.id, name: p.name, team: p.team, role: p.role }])
        ),
      };
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify(serializable));
  } catch {}
}

function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
      for (const [id, room] of Object.entries(data as Record<string, any>)) {
        rooms[id] = { ...room, players: {} }; // players reconnect via WS
      }
    }
  } catch {}
}

loadStore();

// ─── Board Generation ───────────────────────────────────────────────────────

function shuffle(array: any[]) { return array.sort(() => Math.random() - 0.5); }

function generateBoard(wordPool?: string[]): Card[] {
  const pool = wordPool && wordPool.length >= 25 ? wordPool : WORDS;
  const chosenWords = shuffle([...pool]).slice(0, 25);
  const starter = Math.random() < 0.5 ? 'red' : 'blue';
  const types = [
    ...Array(starter === 'red' ? 9 : 8).fill('red'),
    ...Array(starter === 'blue' ? 9 : 8).fill('blue'),
    ...Array(7).fill('neutral'),
    'assassin'
  ];
  shuffle(types);
  return chosenWords.map((word, i) => ({ id: i, word, type: types[i], revealed: false }));
}

function createRoom(roomId: string, wordSet?: string[], timerDurationMs = 0, enforceTimer = false) {
  const pool = wordSet && wordSet.length >= 25 ? wordSet : WORDS;
  const board = generateBoard(pool);
  const redCount = board.filter(c => c.type === 'red').length;
  rooms[roomId] = {
    roomId, players: {}, board,
    currentTurn: redCount === 9 ? 'red' : 'blue',
    winner: null, log: [], redLeft: redCount, blueLeft: board.filter(c => c.type === 'blue').length,
    clue: null,
    timerDurationMs,
    enforceTimer,
    roundStartedAt: Date.now(),
    wordSet: pool,
    createdAt: Date.now(),
  };
  saveStore();
}

// ─── Game Cleanup ───────────────────────────────────────────────────────────

function cleanupOldGames() {
  const now = Date.now();
  for (const [id, room] of Object.entries(rooms)) {
    const age = now - room.createdAt;
    if (room.winner && age > 3 * 60 * 60 * 1000) {
      delete rooms[id];
    } else if (age > 72 * 60 * 60 * 1000) {
      delete rooms[id];
    }
  }
  saveStore();
}

setInterval(cleanupOldGames, 10 * 60 * 1000);

// ─── Stats Endpoint ─────────────────────────────────────────────────────────

let statTotalRequests = 0;
let statOpenRequests = 0;

app.use((req, res, next) => { statTotalRequests++; statOpenRequests++; res.on('finish', () => statOpenRequests--); next(); });

app.get('/stats', (_req, res) => {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  let inProgress = 0, createdOneHour = 0;
  for (const room of Object.values(rooms)) {
    if (!room.winner && room.board.some(c => c.revealed)) inProgress++;
    if (room.createdAt > hourAgo) createdOneHour++;
  }
  res.json({
    games_total: Object.keys(rooms).length,
    games_in_progress: inProgress,
    games_created_1h: createdOneHour,
    requests_total_process_lifetime: statTotalRequests,
    requests_in_flight: statOpenRequests,
  });
});

app.get('/word-sets', (_req, res) => {
  const result: Record<string, number> = {};
  for (const [name, words] of Object.entries(wordSets)) {
    result[name] = words.length;
  }
  res.json(result);
});

// ─── Broadcast ──────────────────────────────────────────────────────────────

function broadcast(roomId: string) {
  const room = rooms[roomId];
  if (!room) return;
  const stateToPlayers = Object.values(room.players).map(p => {
    const isSpymaster = p.role === 'spymaster';
    const board = room.board.map(c => ({
      ...c,
      type: (c.revealed || isSpymaster || room.winner) ? c.type : 'hidden'
    }));
    return {
      ws: p.ws,
      state: {
        roomId, currentTurn: room.currentTurn, winner: room.winner,
        redLeft: room.redLeft, blueLeft: room.blueLeft,
        clue: room.clue, log: room.log, board,
        timerDurationMs: room.timerDurationMs,
        enforceTimer: room.enforceTimer,
        roundStartedAt: room.roundStartedAt,
        players: Object.values(room.players).map(pl => ({ id: pl.id, name: pl.name, team: pl.team, role: pl.role })),
        me: { team: p.team, role: p.role }
      }
    };
  });
  
  stateToPlayers.forEach(({ ws, state }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'state', state }));
    }
  });
  saveStore();
}

// ─── Auto-generated Game IDs ────────────────────────────────────────────────

const gameIdWords = [
  'alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','india',
  'juliet','kilo','lima','mike','november','oscar','papa','quebec','romeo',
  'sierra','tango','uniform','victor','whiskey','xray','yankee','zulu',
  'apple','banana','cherry','dragon','eagle','falcon','glacier','harbor',
  'island','jungle','knight','lemon','mango','noble','ocean','panther',
  'quartz','river','shadow','tiger','umbra','vortex','willow','xenon',
];

function generateGameId(): string {
  for (let attempts = 0; ; attempts++) {
    const wordCount = 2 + Math.floor(attempts / 5);
    const words: string[] = [];
    for (let j = 0; j < wordCount; j++) {
      words.push(gameIdWords[Math.floor(Math.random() * gameIdWords.length)]);
    }
    const id = words.join('-');
    if (!rooms[id]) return id;
  }
}

// ─── WebSocket Handler ──────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  let pId = Math.random().toString(36).slice(2, 9);
  let cRoom: string | null = null;

  // Send available word sets and auto-generated game ID on connect
  ws.send(JSON.stringify({
    type: 'init',
    wordSets: Object.fromEntries(Object.entries(wordSets).map(([k, v]) => [k, v.length])),
    autogeneratedGameId: generateGameId(),
  }));

  ws.on('message', (msg) => {
    const data = JSON.parse(msg.toString());
    
    if (data.type === 'join') {
      cRoom = data.roomId;
      if (!rooms[cRoom!]) createRoom(cRoom!, data.wordSet, data.timerDurationMs || 0, data.enforceTimer || false);
      rooms[cRoom!].players[pId] = { id: pId, name: data.name, ws, team: null, role: null };
      rooms[cRoom!].log.push(`${data.name} joined.`);
      broadcast(cRoom!);
    }
    
    if (!cRoom || !rooms[cRoom]) return;
    const room = rooms[cRoom];
    const me = room.players[pId];

    if (data.type === 'setRole') {
      me.team = data.team; me.role = data.role;
      room.log.push(`${me.name} joined ${data.team} as ${data.role}.`);
      broadcast(cRoom);
    }
    
    if (data.type === 'giveClue' && me.team === room.currentTurn && me.role === 'spymaster' && !room.clue && !room.winner) {
      room.clue = { word: data.word, count: Number(data.count) };
      room.roundStartedAt = Date.now();
      room.log.push(`[${me.team.toUpperCase()}] Clue: ${data.word} (${data.count})`);
      broadcast(cRoom);
    }
    
    if (data.type === 'guess' && me.team === room.currentTurn && me.role === 'operative' && room.clue && !room.winner) {
      const card = room.board.find(c => c.id === data.cardId);
      if (!card || card.revealed) return;
      
      card.revealed = true;
      room.log.push(`${me.name} guessed ${card.word}. It was ${card.type}.`);
      
      if (card.type === 'assassin') {
        room.winner = me.team === 'red' ? 'blue' : 'red';
        room.log.push(`Assassin revealed! ${room.winner.toUpperCase()} wins!`);
      } else if (card.type === me.team) {
        if (me.team === 'red') room.redLeft--; else room.blueLeft--;
        if (room.redLeft === 0 || room.blueLeft === 0) {
          room.winner = me.team;
          room.log.push(`${me.team.toUpperCase()} reveals all words and wins!`);
        }
      } else {
        if (card.type === (me.team === 'red' ? 'blue' : 'red')) {
          if (me.team === 'red') room.blueLeft--; else room.redLeft--;
          if (room.redLeft === 0 || room.blueLeft === 0) {
             room.winner = me.team === 'red' ? 'blue' : 'red';
             room.log.push(`${room.winner.toUpperCase()} wins by default!`);
          }
        }
        room.currentTurn = room.currentTurn === 'red' ? 'blue' : 'red';
        room.clue = null;
        room.roundStartedAt = Date.now();
        room.log.push(`Turn passes to ${room.currentTurn.toUpperCase()}.`);
      }
      broadcast(cRoom);
    }
    
    if (data.type === 'endTurn' && me.team === room.currentTurn && me.role === 'operative' && !room.winner) {
      room.currentTurn = room.currentTurn === 'red' ? 'blue' : 'red';
      room.clue = null;
      room.roundStartedAt = Date.now();
      room.log.push(`${me.name} ended the turn. Turn passes to ${room.currentTurn.toUpperCase()}.`);
      broadcast(cRoom);
    }

    if (data.type === 'newGame') {
      // Start a next game in the same room
      const wordPool = data.wordSet && data.wordSet.length >= 25 ? data.wordSet : room.wordSet;
      const board = generateBoard(wordPool);
      const redCount = board.filter(c => c.type === 'red').length;
      room.board = board;
      room.currentTurn = redCount === 9 ? 'red' : 'blue';
      room.winner = null;
      room.redLeft = redCount;
      room.blueLeft = board.filter(c => c.type === 'blue').length;
      room.clue = null;
      room.roundStartedAt = Date.now();
      room.log = [];
      room.wordSet = wordPool;
      room.createdAt = Date.now();
      if (data.timerDurationMs !== undefined) room.timerDurationMs = data.timerDurationMs;
      if (data.enforceTimer !== undefined) room.enforceTimer = data.enforceTimer;
      // Reset roles
      for (const p of Object.values(room.players)) {
        p.team = null;
        p.role = null;
      }
      room.log.push('New game started!');
      broadcast(cRoom);
    }
  });

  ws.on('close', () => {
    if (cRoom && rooms[cRoom]) {
      const name = rooms[cRoom].players[pId]?.name;
      delete rooms[cRoom].players[pId];
      if (name) rooms[cRoom].log.push(`${name} disconnected.`);
      broadcast(cRoom);
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
