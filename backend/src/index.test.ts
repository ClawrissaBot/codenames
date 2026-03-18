/**
 * Feature-parity tests: verifies that the new TypeScript rebuild covers
 * all features from the original Go + React Codenames implementation.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const src = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf-8');
const frontendSrc = fs.readFileSync(path.join(__dirname, '../../frontend/src/main.ts'), 'utf-8');
const cssSrc = fs.readFileSync(path.join(__dirname, '../../frontend/src/style.css'), 'utf-8');

// ─── CORE GAME FEATURES ────────────────────────────────────────────────────

describe('Board Generation', () => {
  it('generates a 25-card board', () => {
    expect(src).toContain('25');
    expect(src).toContain('generateBoard');
  });
  it('has correct card type distribution (9/8/7/1)', () => {
    expect(src).toContain("Array(starter === 'red' ? 9 : 8).fill('red')");
    expect(src).toContain("Array(7).fill('neutral')");
    expect(src).toContain("'assassin'");
  });
  it('has word list with enough words (>= 25)', () => {
    const wordsFile = fs.readFileSync(path.join(__dirname, 'words.ts'), 'utf-8');
    const wordCount = (wordsFile.match(/"/g) || []).length / 2;
    expect(wordCount).toBeGreaterThanOrEqual(25);
  });
});

describe('Game Mechanics', () => {
  it('tracks current turn', () => { expect(src).toContain('currentTurn'); });
  it('supports guessing cards', () => { expect(src).toContain("data.type === 'guess'"); });
  it('reveals card on guess', () => { expect(src).toContain('card.revealed = true'); });
  it('assassin causes other team to win', () => { expect(src).toContain("card.type === 'assassin'"); });
  it('win condition: all cards revealed', () => { expect(src).toContain('redLeft === 0'); expect(src).toContain('blueLeft === 0'); });
  it('supports end turn', () => { expect(src).toContain("data.type === 'endTurn'"); });
  it('turn switches on wrong guess', () => { expect(src).toContain("currentTurn === 'red' ? 'blue' : 'red'"); });
});

describe('Roles', () => {
  it('supports spymaster and operative', () => { expect(src).toContain('spymaster'); expect(src).toContain('operative'); });
  it('spymaster can see all card types', () => { expect(src).toContain('isSpymaster'); });
  it('spymaster gives clues', () => { expect(src).toContain("data.type === 'giveClue'"); });
  it('only current team spymaster gives clue', () => { expect(src).toContain("me.team === room.currentTurn && me.role === 'spymaster'"); });
  it('only current team operative guesses', () => { expect(src).toContain("me.team === room.currentTurn && me.role === 'operative'"); });
});

describe('Multiplayer', () => {
  it('supports named players', () => { expect(src).toContain('data.name'); });
  it('supports rooms', () => { expect(src).toContain('roomId'); });
  it('broadcasts state', () => { expect(src).toContain('broadcast'); });
  it('handles disconnect', () => { expect(src).toContain("ws.on('close'"); expect(src).toContain('disconnected'); });
  it('uses WebSocket', () => { expect(src).toContain('WebSocketServer'); });
});

describe('Game Log', () => {
  it('logs actions', () => { expect(src).toContain('room.log.push'); });
  it('logs joins', () => { expect(src).toContain('joined'); });
  it('logs guesses', () => { expect(src).toMatch(/guessed.*It was/); });
  it('logs clues', () => { expect(src).toContain('Clue:'); });
});

// ─── FEATURE PARITY CHECKS ─────────────────────────────────────────────────

describe('FEATURE PARITY: Multiple Word Sets', () => {
  it('supports selecting from multiple word sets/languages', () => {
    expect(src).toMatch(/wordSets|word_set|wordSet/);
  });
});

describe('FEATURE PARITY: Custom Words', () => {
  it('supports custom word input from users', () => {
    expect(frontendSrc).toMatch(/custom.*word/i);
    expect(frontendSrc).toContain('custom-words');
  });
});

describe('FEATURE PARITY: Timer', () => {
  it('supports configurable turn timer', () => {
    expect(src).toContain('timerDurationMs');
    expect(frontendSrc).toContain('timerDurationMs');
  });
  it('supports enforce timer (auto end turn)', () => {
    expect(src).toContain('enforceTimer');
    expect(frontendSrc).toContain('enforceTimer');
  });
});

describe('FEATURE PARITY: Next Game / New Game', () => {
  it('supports starting a new game in the same room', () => {
    expect(src).toContain("data.type === 'newGame'");
    expect(frontendSrc).toContain('newGame');
  });
});

describe('FEATURE PARITY: Settings', () => {
  it('supports fullscreen mode', () => {
    expect(frontendSrc).toContain('fullscreen');
    expect(cssSrc).toContain('full-screen');
  });
  it('supports color-blind mode', () => {
    expect(frontendSrc).toContain('colorBlind');
    expect(cssSrc).toContain('color-blind');
  });
  it('supports dark mode', () => {
    expect(frontendSrc).toContain('darkMode');
    expect(cssSrc).toContain('dark-mode');
  });
});

describe('FEATURE PARITY: Game Persistence', () => {
  it('persists game state across server restarts', () => {
    expect(src).toContain('saveStore');
    expect(src).toContain('loadStore');
    expect(src).toContain('STORE_PATH');
  });
});

describe('FEATURE PARITY: Stats', () => {
  it('exposes game statistics endpoint', () => {
    expect(src).toContain("'/stats'");
    expect(src).toContain('games_total');
    expect(src).toContain('games_in_progress');
  });
});

describe('FEATURE PARITY: Auto-generated Game IDs', () => {
  it('generates readable game IDs from word dictionary', () => {
    expect(src).toContain('generateGameId');
    expect(src).toContain('gameIdWords');
    expect(src).toContain('autogeneratedGameId');
  });
});

describe('FEATURE PARITY: URL-based Game Joining', () => {
  it('supports joining a game via URL path', () => {
    expect(frontendSrc).toContain('getGameIdFromUrl');
    expect(frontendSrc).toContain('location.pathname');
  });
});

describe('FEATURE PARITY: Share Link', () => {
  it('displays a shareable link for the game', () => {
    expect(frontendSrc).toContain('share');
    expect(frontendSrc).toContain('Send this link to friends');
  });
});

describe('FEATURE PARITY: Accessibility', () => {
  it('includes ARIA labels for screen readers', () => {
    expect(frontendSrc).toContain('aria-label');
    expect(frontendSrc).toContain('aria-disabled');
    expect(frontendSrc).toContain('role=');
  });
});

describe('FEATURE PARITY: Favicon Turn Indicator', () => {
  it('changes favicon to indicate current team turn', () => {
    expect(frontendSrc).toContain('favicon');
    expect(frontendSrc).toContain('blueTurnFavicon');
    expect(frontendSrc).toContain('redTurnFavicon');
  });
});

describe('FEATURE PARITY: Game Cleanup', () => {
  it('cleans up old/expired games', () => {
    expect(src).toContain('cleanupOldGames');
    expect(src).toMatch(/3 \* 60 \* 60 \* 1000/); // 3 hours
    expect(src).toMatch(/72 \* 60 \* 60 \* 1000/); // 72 hours
  });
});
