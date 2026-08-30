// server.js
'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// 게임 상수
// ---------------------------------------------------------------------------
const MAX_ROOMS = 10;          // 동시 개설 가능 최대 방 수
const MAX_PLAYERS_PER_ROOM = 4; // 방 당 최대 인원
const MIN_PLAYERS_TO_START = 2; // 게임 시작 최소 인원
const TICK_MS = 250;            // 한 칸 전진 간격 (클라이언트와 동일하게 유지)
const DICE_ANIM_MS = 700;       // 주사위 굴리는 연출 시간
const SLIDE_MS = 400;           // 뱀/파이프 슬라이드 연출 시간

const PLAYER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f']; // 빨강, 파랑, 초록, 노랑

// 파이프(지름길, 위로 이동) - 시작칸 -> 도착칸
// 실제 board.png에 그려진 파이프 그림 그대로 매핑한다.
const LADDERS = {
  4: 16,
  8: 12,
  18: 38,
  20: 74,
  32: 56,
  70: 88,
  76: 86,
  80: 100,
  90: 92,
  24: 36,
  40: 60,
  48: 54
};

// 뱀(내려감) - 꼬리칸(도착한 칸) -> 머리칸(이동할 칸)
// 실제 board.png에 그려진 뱀 그림 그대로 매핑한다.
const SNAKES = {
  28: 6,
  22: 2,
  30: 10,
  66: 14,
  44: 26,
  72: 50,
  68: 52,
  58: 42,
  94: 64,
  98: 78,
  96: 82,
  84: 62
};

// ---------------------------------------------------------------------------
// 방 상태 저장소 (서버 메모리)
// ---------------------------------------------------------------------------
/**
 * rooms[roomId] = {
 *   id, players: [{ id, nick, name, color, position, isHost }],
 *   currentTurnIndex, started
 * }
 */
const rooms = {};

function generateRoomId() {
  let id;
  do {
    id = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms[id]);
  return id;
}

function getRoomList() {
  return Object.keys(rooms).length;
}

function publicRoomState(room) {
  return {
    roomId: room.id,
    players: room.players.map((p) => ({
      id: p.id,
      nick: p.nick,
      name: p.name,
      color: p.color,
      position: p.position,
      isHost: p.isHost
    })),
    currentTurnIndex: room.currentTurnIndex,
    started: room.started
  };
}

function broadcastRoomUpdate(room) {
  io.to(room.id).emit('roomUpdate', publicRoomState(room));
}

function deleteRoomIfEmpty(room) {
  if (room.players.length === 0) {
    delete rooms[room.id];
  }
}

function findRoomBySocket(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return null;
  return rooms[roomId] || null;
}

// 주사위 합만큼 이동 경로(오버 규칙 포함)를 계산한다.
function calculatePath(start, sum) {
  const path = [];
  let pos = start;
  const target = start + sum;

  if (target <= 100) {
    for (let i = 0; i < sum; i++) {
      pos++;
      path.push(pos);
    }
  } else {
    while (pos < 100) {
      pos++;
      path.push(pos);
    }
    const excess = target - 100;
    for (let i = 0; i < excess; i++) {
      pos--;
      path.push(pos);
    }
  }
  return path;
}

function nextAliveIndex(room, fromIndex) {
  if (room.players.length === 0) return 0;
  return fromIndex % room.players.length;
}

// ---------------------------------------------------------------------------
// 소켓 이벤트
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }) => {
    if (findRoomBySocket(socket)) return;

    const trimmed = (name || '').toString().trim();
    if (!trimmed) {
      socket.emit('errorMsg', '이름을 입력해주세요.');
      return;
    }

    if (getRoomList() >= MAX_ROOMS) {
      socket.emit('errorMsg', '개설 가능한 방이 없습니다.');
      return;
    }

    const roomId = generateRoomId();
    const room = {
      id: roomId,
      players: [],
      currentTurnIndex: 0,
      started: false
    };
    rooms[roomId] = room;

    const player = {
      id: socket.id,
      nick: trimmed.substring(0, 2),
      name: trimmed,
      color: PLAYER_COLORS[0],
      position: 0,
      isHost: true
    };
    room.players.push(player);

    socket.data.roomId = roomId;
    socket.join(roomId);

    socket.emit('joinedRoom', { selfId: socket.id, ...publicRoomState(room) });
    broadcastRoomUpdate(room);
  });

  socket.on('joinRoom', ({ name, roomId }) => {
    if (findRoomBySocket(socket)) return;

    const trimmed = (name || '').toString().trim();
    const code = (roomId || '').toString().trim();

    if (!trimmed) {
      socket.emit('errorMsg', '이름을 입력해주세요.');
      return;
    }
    if (!code) {
      socket.emit('errorMsg', '방 코드를 입력해주세요.');
      return;
    }

    const room = rooms[code];
    if (!room) {
      socket.emit('errorMsg', '존재하지 않는 방입니다.');
      return;
    }
    if (room.started) {
      socket.emit('errorMsg', '이미 시작된 게임입니다.');
      return;
    }
    if (room.players.length >= MAX_PLAYERS_PER_ROOM) {
      socket.emit('errorMsg', '방 인원이 가득 찼습니다.');
      return;
    }

    const player = {
      id: socket.id,
      nick: trimmed.substring(0, 2),
      name: trimmed,
      color: PLAYER_COLORS[room.players.length % PLAYER_COLORS.length],
      position: 0,
      isHost: false
    };
    room.players.push(player);

    socket.data.roomId = room.id;
    socket.join(room.id);

    socket.emit('joinedRoom', { selfId: socket.id, ...publicRoomState(room) });
    broadcastRoomUpdate(room);
  });

  socket.on('startGame', () => {
    const room = findRoomBySocket(socket);
    if (!room || room.started) return;

    const player = room.players.find((p) => p.id === socket.id);
    if (!player || !player.isHost) return;

    if (room.players.length < MIN_PLAYERS_TO_START) {
      socket.emit('errorMsg', `최소 ${MIN_PLAYERS_TO_START}명 이상이어야 시작할 수 있습니다.`);
      return;
    }

    room.started = true;
    room.currentTurnIndex = 0;
    io.to(room.id).emit('gameStarted', publicRoomState(room));
  });

  socket.on('rollDice', () => {
    const room = findRoomBySocket(socket);
    if (!room || !room.started) return;

    const currentPlayer = room.players[room.currentTurnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) return;

    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);
    const sum = d1 + d2;

    io.to(room.id).emit('diceResult', {
      playerId: currentPlayer.id,
      d1,
      d2,
      sum
    });

    const path = calculatePath(currentPlayer.position, sum);
    const landedAt = path[path.length - 1];
    const slideTo = LADDERS[landedAt] || SNAKES[landedAt] || null;

    setTimeout(() => {
      if (!rooms[room.id]) return; // 방이 이미 사라진 경우
      io.to(room.id).emit('movePath', {
        playerId: currentPlayer.id,
        path,
        slideTo
      });

      const totalMoveMs = path.length * TICK_MS + (slideTo ? SLIDE_MS : 0);

      setTimeout(() => {
        const liveRoom = rooms[room.id];
        if (!liveRoom) return;
        const livePlayer = liveRoom.players.find((p) => p.id === currentPlayer.id);
        if (!livePlayer) return;

        livePlayer.position = slideTo || landedAt;

        if (livePlayer.position === 100) {
          io.to(liveRoom.id).emit('gameOver', {
            winnerId: livePlayer.id,
            winnerNick: livePlayer.nick,
            winnerName: livePlayer.name
          });
          liveRoom.started = false;
          broadcastRoomUpdate(liveRoom);
          return;
        }

        liveRoom.currentTurnIndex = nextAliveIndex(
          liveRoom,
          liveRoom.players.findIndex((p) => p.id === livePlayer.id) + 1
        );

        io.to(liveRoom.id).emit('turnChanged', publicRoomState(liveRoom));
      }, totalMoveMs + 200);
    }, DICE_ANIM_MS);
  });

  socket.on('disconnect', () => {
    const room = findRoomBySocket(socket);
    if (!room) return;

    const leavingIndex = room.players.findIndex((p) => p.id === socket.id);
    if (leavingIndex === -1) return;

    const wasHost = room.players[leavingIndex].isHost;
    room.players.splice(leavingIndex, 1);

    if (room.players.length === 0) {
      deleteRoomIfEmpty(room);
      return;
    }

    if (wasHost) {
      room.players[0].isHost = true;
    }

    if (leavingIndex < room.currentTurnIndex) {
      room.currentTurnIndex -= 1;
    }
    room.currentTurnIndex = nextAliveIndex(room, room.currentTurnIndex);

    broadcastRoomUpdate(room);
    if (room.started) {
      io.to(room.id).emit('turnChanged', publicRoomState(room));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Snake Dice Board Game server running on port ${PORT}`);
});
