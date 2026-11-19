/**
 * Games engine for Levanter plugins in MIAS:
 * - Tic-Tac-Toe
 * - Word Chain Game (wcg) & Word Rush Game (wrg)
 */

const SYMBOLS = {
  X: "❌",
  O: "⭕",
  "1": "1️⃣",
  "2": "2️⃣",
  "3": "3️⃣",
  "4": "4️⃣",
  "5": "5️⃣",
  "6": "6️⃣",
  "7": "7️⃣",
  "8": "8️⃣",
  "9": "9️⃣",
};

const WINNING_COMBOS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6]
];

const tttRooms = new Map();

export function isTactacToe(sessionId = "0") {
  return tttRooms.has(String(sessionId));
}

export async function delTicTacToe(sessionId = "0") {
  const key = String(sessionId);
  if (tttRooms.has(key)) {
    tttRooms.delete(key);
    return true;
  }
  return false;
}

function formatBoard(board) {
  let str = "";
  for (let i = 0; i < 9; i++) {
    const val = board[i];
    str += SYMBOLS[val] || SYMBOLS[String(i + 1)];
    if ((i + 1) % 3 === 0) {
      str += "\n";
    } else {
      str += " ";
    }
  }
  return str.trim();
}

function checkWinner(board) {
  for (const [a, b, c] of WINNING_COMBOS) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  if (board.every(cell => cell !== undefined)) return "tie";
  return null;
}

export async function ticTacToe(chatJid, me, opponent, sessionId = "0", mode = "normal") {
  const key = String(sessionId);
  let game = tttRooms.get(key);

  const meTag = me.split("@")[0];
  const oppTag = opponent.split("@")[0];

  if (!game) {
    game = {
      chatJid,
      playerX: me,
      playerO: opponent,
      current: me,
      board: Array(9).fill(undefined),
      mode,
    };
    tttRooms.set(key, game);

    const boardText = formatBoard(game.board);
    const text = `🎮 *Tic-Tac-Toe*\n\n❌ : @${meTag}\n⭕ : @${oppTag}\n\n*Current Turn:* @${meTag}\n\n${boardText}\n\n_Reply with a number (1-9) to make your move!_`;
    return { text, game };
  }

  // Already running: return current state
  const curTag = game.current.split("@")[0];
  const boardText = formatBoard(game.board);
  return {
    text: `🎮 *Tic-Tac-Toe*\n\n❌ : @${meTag}\n⭕ : @${oppTag}\n\n*Current Turn:* @${curTag}\n\n${boardText}`,
    game
  };
}

export function makeTttMove(sessionId, player, moveNum) {
  const key = String(sessionId);
  const game = tttRooms.get(key);
  if (!game) return null;
  if (game.current !== player) return { error: "not_your_turn" };

  const idx = Number(moveNum) - 1;
  if (idx < 0 || idx > 8 || game.board[idx] !== undefined) {
    return { error: "invalid_move" };
  }

  const mark = player === game.playerX ? "X" : "O";
  game.board[idx] = mark;

  const winner = checkWinner(game.board);
  const nextPlayer = player === game.playerX ? game.playerO : game.playerX;
  game.current = nextPlayer;

  const boardText = formatBoard(game.board);
  if (winner === "tie") {
    tttRooms.delete(key);
    return { status: "tie", text: `🤝 *Game Over - It's a Tie!*\n\n${boardText}` };
  } else if (winner) {
    tttRooms.delete(key);
    const winTag = player.split("@")[0];
    return { status: "win", winner: player, text: `🎉 *@${winTag} Won the Game!*\n\n${boardText}` };
  }

  const nextTag = nextPlayer.split("@")[0];
  return {
    status: "ongoing",
    text: `*Current Turn:* @${nextTag}\n\n${boardText}`,
  };
}

// Word Chain Game / Word Rush Game engine
const wcgRooms = new Map();

export const wcg = {
  start_game: async (chatJid, participant, type = "chain", sessionId = "0", difficulty = "easy") => {
    const key = `${sessionId}_${chatJid}`;
    const wordList = ["apple", "elephant", "tiger", "rabbit", "table", "earth", "house", "energy", "yellow", "water"];
    const startingWord = wordList[Math.floor(Math.random() * wordList.length)];

    wcgRooms.set(key, {
      chatJid,
      participant,
      type,
      difficulty,
      history: [startingWord],
      lastWord: startingWord,
      score: 0,
      active: true,
      startedAt: Date.now()
    });

    const isChain = type === "chain";
    const rules = isChain
      ? `Word Chain Game started!\nLast letter was *"${startingWord.slice(-1).toUpperCase()}"*.\nSend a word starting with *"${startingWord.slice(-1).toUpperCase()}"*!`
      : `Word Rush Game started!\nForm words related to *"${startingWord}"*!`;

    return rules;
  },

  end: async (chatJid, participant, sessionId = "0") => {
    const key = `${sessionId}_${chatJid}`;
    const room = wcgRooms.get(key);
    if (!room) return "No active game to end.";
    wcgRooms.delete(key);
    return `Game ended! Total score: *${room.score}*.`;
  },

  game_running: (chatJid, sessionId = "0") => {
    const key = `${sessionId}_${chatJid}`;
    return wcgRooms.has(key);
  }
};
