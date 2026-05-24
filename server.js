const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const GAME_VERSION = "rules-2026-05-24-1";
const rooms = new Map();
const sockets = new Map();

const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const suits = ["S", "H", "D", "C"];
const categories = ["high", "pair", "twoPair", "three", "straight", "flush", "full", "four", "straightFlush"];

const categoryLabels = {
  high: "wysoka karta",
  pair: "para",
  twoPair: "dwie pary",
  three: "trojka",
  straight: "strit",
  flush: "kolor",
  full: "full",
  four: "kareta",
  straightFlush: "poker",
};

function send(ws, message) {
  if (!ws.destroyed) ws.write(encodeFrame(JSON.stringify(message)));
}

function broadcast(room, message) {
  for (const player of room.players) {
    if (player.ws && !player.ws.destroyed) send(player.ws, viewFor(room, player.id, message));
  }
}

function system(room, text) {
  room.toast = text;
  room.chat.push({ system: true, text, at: Date.now() });
  trimChat(room);
}

function trimChat(room) {
  if (room.chat.length > 80) room.chat = room.chat.slice(-80);
}

function id(size = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let output = "";
  for (let i = 0; i < size; i += 1) output += alphabet[crypto.randomInt(alphabet.length)];
  return output;
}

function cardValue(rank) {
  return ranks.indexOf(rank) + 2;
}

function valueRank(value) {
  return ranks[value - 2];
}

function makeDeck(playerCount, fixedMinValue) {
  const minValue = fixedMinValue || deckMinValue(playerCount);
  const deck = [];
  for (const rank of ranks) {
    if (cardValue(rank) < minValue) continue;
    for (const suit of suits) deck.push({ rank, suit });
  }
  return shuffle(deck);
}

function deckMinValue(playerCount) {
  return Math.max(2, 13 - playerCount);
}

function allowedRankValues(room) {
  const minValue = room.minValue || deckMinValue(alive(room).length || room.players.length || 4);
  return ranks.map(cardValue).filter((value) => value >= minValue);
}

function straightHighValues(room) {
  const minValue = room.minValue || deckMinValue(alive(room).length || room.players.length || 4);
  return ranks.map(cardValue).filter((value) => value >= minValue + 4);
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function draw(room) {
  if (!room.deck.length) room.deck = shuffle(room.discard.splice(0));
  return room.deck.pop();
}

function createRoom(hostNick) {
  const room = {
    id: id(),
    hostId: null,
    status: "lobby",
    players: [],
    deck: [],
    discard: [],
    activeId: null,
    previousActorId: null,
    currentBid: null,
    minValue: 9,
    bidHistory: [],
    chat: [],
    toast: "",
    revealed: false,
    revealCards: [],
    round: 0,
  };
  rooms.set(room.id, room);
  addPlayer(room, hostNick, true);
  return room;
}

function addPlayer(room, nick, host = false) {
  const player = {
    id: id(10),
    nick: String(nick || "Gracz").trim().slice(0, 24) || "Gracz",
    hand: [],
    connected: true,
    eliminated: false,
    host,
    ws: null,
  };
  room.players.push(player);
  if (host || !room.hostId) {
    room.hostId = player.id;
    player.host = true;
  }
  return player;
}

function alive(room) {
  return room.players.filter((p) => !p.eliminated);
}

function nextPlayer(room, fromId) {
  const list = room.players;
  let index = Math.max(0, list.findIndex((p) => p.id === fromId));
  for (let step = 1; step <= list.length; step += 1) {
    const candidate = list[(index + step) % list.length];
    if (!candidate.eliminated && candidate.connected) return candidate;
  }
  return alive(room)[0];
}

function startGame(room) {
  if (room.status !== "lobby") throw new Error("Gra juz trwa.");
  if (room.players.length < 4) throw new Error("Potrzeba minimum 4 graczy.");
  room.status = "game";
  room.round = 0;
  room.minValue = deckMinValue(room.players.length);
  room.players.forEach((p) => {
    p.eliminated = false;
    p.hand = [];
  });
  newRound(room, room.players[0].id, true);
  system(room, "Gra rozpoczeta. Pierwszy gracz sklada ogloszenie.");
}

function newRound(room, starterId, deal = false) {
  room.round += 1;
  room.revealed = false;
  room.revealCards = [];
  room.currentBid = null;
  room.bidHistory = [];
  room.previousActorId = null;
  if (deal || room.deck.length < room.players.length * 5) {
    const handSizes = new Map(room.players.map((p) => [p.id, deal ? 1 : p.hand.length]));
    room.discard.push(...room.players.flatMap((p) => p.hand));
    room.deck = makeDeck(room.players.length, room.minValue);
    room.discard = [];
    for (const p of room.players) {
      if (p.eliminated) continue;
      p.hand = [];
      const count = Math.max(1, Math.min(5, handSizes.get(p.id) || 1));
      for (let i = 0; i < count; i += 1) p.hand.push(draw(room));
    }
  }
  room.activeId = starterId;
  const active = room.players.find((p) => p.id === room.activeId && !p.eliminated && p.connected) || alive(room)[0];
  room.activeId = active ? active.id : null;
}

function applyPenalty(room, playerId) {
  const player = room.players.find((p) => p.id === playerId);
  if (!player || player.eliminated) return;
  if (player.hand.length >= 5) {
    player.eliminated = true;
    room.discard.push(...player.hand);
    player.hand = [];
    system(room, `${player.nick} odpada z gry.`);
    return;
  }
  player.hand.push(draw(room));
  system(room, `${player.nick} dobiera 1 karte.`);
}

function bidScore(bid) {
  const cat = categories.indexOf(bid.category);
  const values = normalizeBidValues(bid);
  return [cat, ...values];
}

function normalizeBidValues(bid) {
  const values = (bid.values || []).map(Number).filter(Boolean);
  if (bid.category === "high" || bid.category === "pair" || bid.category === "three" || bid.category === "four") return [values[0] || 2];
  if (bid.category === "straight" || bid.category === "flush" || bid.category === "straightFlush") return [values[0] || 2];
  if (bid.category === "twoPair") return [values[0] || 2, values[1] || 2].sort((a, b) => b - a);
  if (bid.category === "full") return [values[0] || 2, values[1] || 2];
  return values;
}

function compareBid(a, b) {
  const left = bidScore(a);
  const right = bidScore(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function validateBid(bid, previous, room) {
  if (!bid || !categories.includes(bid.category)) throw new Error("Niepoprawne ogloszenie.");
  bid.values = normalizeBidValues(bid);
  if (["flush", "straightFlush"].includes(bid.category) && !suits.includes(bid.suit)) throw new Error("Wybierz kolor.");
  const legalValues = ["straight", "straightFlush", "flush"].includes(bid.category) ? straightHighValues(room) : allowedRankValues(room);
  if (!bid.values.every((value) => legalValues.includes(value))) throw new Error("Ta karta nie wystepuje w aktualnej talii.");
  if (["twoPair", "full"].includes(bid.category) && bid.values[0] === bid.values[1]) throw new Error("Wybierz dwie rozne wartosci.");
  if (previous && compareBid(bid, previous) <= 0) throw new Error("Ogloszenie musi byc wyzsze od poprzedniego.");
  return bid;
}

function bidExists(cards, bid) {
  const counts = new Map();
  for (const card of cards) counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
  const valueCounts = new Map([...counts].map(([rank, count]) => [cardValue(rank), count]));
  const hasCount = (value, count) => (valueCounts.get(value) || 0) >= count;
  const values = [...new Set(cards.map((card) => cardValue(card.rank)))].sort((a, b) => a - b);
  const straightHas = (high, sameSuit) => {
    const start = high - 4;
    if (start < 2) return false;
    for (let v = start; v <= high; v += 1) {
      if (sameSuit) {
        if (!cards.some((c) => cardValue(c.rank) === v && c.suit === bid.suit)) return false;
      } else if (!values.includes(v)) return false;
    }
    return true;
  };
  const [a, b] = normalizeBidValues(bid);
  if (bid.category === "high") return values.some((v) => v >= a);
  if (bid.category === "pair") return hasCount(a, 2);
  if (bid.category === "three") return hasCount(a, 3);
  if (bid.category === "four") return hasCount(a, 4);
  if (bid.category === "twoPair") return hasCount(a, 2) && hasCount(b, 2) && a !== b;
  if (bid.category === "full") return hasCount(a, 3) && hasCount(b, 2) && a !== b;
  if (bid.category === "straight") return straightHas(a, false);
  if (bid.category === "straightFlush") return straightHas(a, true);
  if (bid.category === "flush") return cards.filter((c) => c.suit === bid.suit && cardValue(c.rank) <= a).length >= 5;
  return false;
}

function describeBid(bid) {
  if (!bid) return "";
  const values = normalizeBidValues(bid).map(valueRank);
  const suit = bid.suit ? ` ${suitSymbol(bid.suit)}` : "";
  if (bid.category === "twoPair") return `${categoryLabels[bid.category]} ${values[0]} i ${values[1]}`;
  if (bid.category === "full") return `${categoryLabels[bid.category]} ${values[0]} na ${values[1]}`;
  if (bid.category === "straight" || bid.category === "straightFlush") return `${categoryLabels[bid.category]} do ${values[0]}${suit}`;
  if (bid.category === "flush") return `${categoryLabels[bid.category]} do ${values[0]}${suit}`;
  return `${categoryLabels[bid.category]} ${values[0]}`;
}

function suitSymbol(suit) {
  return ({ S: "pik", H: "kier", D: "karo", C: "trefl" })[suit] || suit;
}

function challenge(room, challengerId) {
  if (!room.currentBid || !room.previousActorId) throw new Error("Nie ma czego sprawdzac.");
  const challenger = room.players.find((p) => p.id === challengerId);
  const checked = room.players.find((p) => p.id === room.previousActorId);
  const cards = alive(room).flatMap((p) => p.hand);
  const trueBid = bidExists(cards, room.currentBid);
  room.revealed = true;
  room.revealCards = room.players.map((p) => ({ id: p.id, nick: p.nick, hand: p.hand, eliminated: p.eliminated }));
  system(room, `${challenger.nick} sprawdza: ${describeBid(room.currentBid)}. Ogloszenie bylo ${trueBid ? "prawdziwe" : "falszywe"}.`);
  const loser = trueBid ? challenger : checked;
  applyPenalty(room, loser.id);
  room.revealCards = room.players.map((p) => ({ id: p.id, nick: p.nick, hand: p.hand, eliminated: p.eliminated }));
  const winners = alive(room);
  if (winners.length <= 1) {
    room.status = "finished";
    room.activeId = null;
    system(room, `Koniec gry. Wygrywa ${winners[0] ? winners[0].nick : "nikt"}.`);
    return;
  }
  const starter = loser.eliminated ? nextPlayer(room, loser.id) : loser;
  setTimeout(() => {
    if (rooms.get(room.id) !== room || room.status !== "game") return;
    newRound(room, starter.id, false);
    system(room, `Nowa runda. Zaczyna ${starter.nick}.`);
    broadcast(room, { type: "state" });
  }, 3500);
}

function viewFor(room, viewerId, envelope = { type: "state" }) {
  const viewer = room.players.find((p) => p.id === viewerId);
  return {
    type: envelope.type || "state",
    error: envelope.error,
    playerId: viewerId,
    roomId: room.id,
    status: room.status,
    hostId: room.hostId,
    activeId: room.activeId,
    currentBid: room.currentBid ? { ...room.currentBid, text: describeBid(room.currentBid) } : null,
    minRankValue: room.minValue || deckMinValue(room.players.length || 4),
    version: GAME_VERSION,
    bidHistory: room.bidHistory,
    chat: room.chat,
    toast: room.toast,
    revealed: room.revealed,
    revealCards: room.revealed ? room.revealCards : [],
    players: room.players.map((p) => ({
      id: p.id,
      nick: p.nick,
      connected: p.connected,
      eliminated: p.eliminated,
      host: p.id === room.hostId,
      handCount: p.hand.length,
      hand: p.id === viewerId || room.revealed ? p.hand : null,
      isYou: p.id === viewerId,
    })),
    you: viewer ? { id: viewer.id, nick: viewer.nick, hand: viewer.hand, host: viewer.id === room.hostId } : null,
  };
}

function handleMessage(ws, raw) {
  const session = sockets.get(ws);
  const message = JSON.parse(raw);
  try {
    if (message.type === "create") {
      const room = createRoom(message.nick);
      const player = room.players[0];
      attach(ws, room, player);
      system(room, `${player.nick} tworzy pokoj.`);
      broadcast(room, { type: "state" });
      return;
    }
    if (message.type === "join") {
      const room = rooms.get(String(message.room || "").toUpperCase());
      if (!room) throw new Error("Nie znaleziono pokoju.");
      if (room.status !== "lobby") throw new Error("Gra w tym pokoju juz trwa.");
      const player = addPlayer(room, message.nick);
      attach(ws, room, player);
      system(room, `${player.nick} dolacza do pokoju.`);
      broadcast(room, { type: "state" });
      return;
    }
    if (!session) throw new Error("Brak sesji.");
    const { room, player } = session;
    if (message.type === "chat") {
      room.chat.push({ nick: player.nick, text: String(message.text || "").slice(0, 400), at: Date.now() });
      trimChat(room);
      broadcast(room, { type: "state" });
      return;
    }
    if (message.type === "start") {
      if (room.hostId !== player.id) throw new Error("Tylko gospodarz moze rozpoczac gre.");
      startGame(room);
      broadcast(room, { type: "state" });
      return;
    }
    if (message.type === "bid") {
      if (room.status !== "game") throw new Error("Gra nie trwa.");
      if (room.activeId !== player.id) throw new Error("To nie twoja tura.");
      const bid = validateBid({ category: message.category, values: message.values, suit: message.suit }, room.currentBid, room);
      room.currentBid = bid;
      room.previousActorId = player.id;
      room.bidHistory.push({ playerId: player.id, nick: player.nick, text: describeBid(bid), at: Date.now() });
      room.activeId = nextPlayer(room, player.id).id;
      system(room, `${player.nick} oglasza: ${describeBid(bid)}.`);
      broadcast(room, { type: "state" });
      return;
    }
    if (message.type === "challenge") {
      if (room.status !== "game") throw new Error("Gra nie trwa.");
      if (room.activeId !== player.id) throw new Error("To nie twoja tura.");
      challenge(room, player.id);
      broadcast(room, { type: "state" });
      return;
    }
  } catch (error) {
    send(ws, { type: "error", error: error.message });
  }
}

function attach(ws, room, player) {
  if (player.ws && player.ws !== ws) player.ws.destroy();
  player.ws = ws;
  player.connected = true;
  sockets.set(ws, { room, player });
}

function disconnect(ws) {
  const session = sockets.get(ws);
  sockets.delete(ws);
  if (!session) return;
  const { room, player } = session;
  player.connected = false;
  if (room.status === "lobby") {
    room.players = room.players.filter((p) => p.id !== player.id);
    if (room.hostId === player.id && room.players[0]) room.hostId = room.players[0].id;
    system(room, `${player.nick} opuszcza pokoj.`);
  } else {
    system(room, `${player.nick} traci polaczenie.`);
    if (room.activeId === player.id) {
      const next = nextPlayer(room, player.id);
      room.activeId = next ? next.id : null;
    }
  }
  if (!room.players.length) rooms.delete(room.id);
  else broadcast(room, { type: "state" });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/version") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ version: GAME_VERSION }));
    return;
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const safe = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(ROOT, safe);
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType(full),
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    });
    res.end(data);
  });
});

server.on("upgrade", (req, socket) => {
  if (req.headers.upgrade?.toLowerCase() !== "websocket") return socket.destroy();
  const key = req.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));
  socket.on("data", (buffer) => {
    for (const message of decodeFrames(buffer)) handleMessage(socket, message);
  });
  socket.on("close", () => disconnect(socket));
  socket.on("error", () => disconnect(socket));
});

function encodeFrame(data) {
  const payload = Buffer.from(data);
  const length = payload.length;
  if (length < 126) return Buffer.concat([Buffer.from([0x81, length]), payload]);
  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f;
    let length = buffer[offset + 1] & 0x7f;
    const masked = Boolean(buffer[offset + 1] & 0x80);
    offset += 2;
    if (length === 126) {
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    const mask = masked ? buffer.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    const payload = buffer.subarray(offset, offset + length);
    offset += length;
    if (opcode === 8) return messages;
    if (opcode !== 1) continue;
    const output = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) output[i] = mask ? payload[i] ^ mask[i % 4] : payload[i];
    messages.push(output.toString("utf8"));
  }
  return messages;
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "application/javascript; charset=utf-8";
  return "application/octet-stream";
}

server.listen(PORT, () => {
  console.log(`Blef dziala na http://localhost:${PORT}`);
});
