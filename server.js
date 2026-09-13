// server.js
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// 메인 화면에 표시할 "최종 업데이트" 시각: 소스 파일들 중 가장 최근에
// 수정된 파일의 mtime을 사용한다(배포/코드 반영 시점을 자동으로 반영).
const SOURCE_FILES_FOR_UPDATE_CHECK = [
  __filename,
  path.join(__dirname, 'public', 'index.html'),
  path.join(__dirname, 'public', 'main.js'),
  path.join(__dirname, 'public', 'style.css')
];

app.get('/api/last-updated', (req, res) => {
  let latest = 0;
  for (const file of SOURCE_FILES_FOR_UPDATE_CHECK) {
    try {
      const mtimeMs = fs.statSync(file).mtimeMs;
      if (mtimeMs > latest) latest = mtimeMs;
    } catch (e) { /* 파일이 없으면 건너뜀 */ }
  }
  res.json({ lastUpdated: latest ? new Date(latest).toISOString() : null });
});

// ---------------------------------------------------------------------------
// 게임 상수
// ---------------------------------------------------------------------------
const MAX_ROOMS = 10;          // 동시 개설 가능 최대 방 수
const MAX_PLAYERS_PER_ROOM = 4; // 방 당 최대 인원
const TICK_MS = 250;            // 한 칸 전진 간격 (클라이언트와 동일하게 유지)
const DICE_ANIM_MS = 700;       // 주사위 굴리는 연출 시간
const SLIDE_MS = 400;           // 뱀/파이프 슬라이드 연출 시간

const PLAYER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f']; // 빨강, 파랑, 초록, 노랑

// 모바일에서 화면 잠금/백그라운드 전환으로 소켓이 일시적으로 끊겼을 때,
// 곧바로 플레이어를 제거하지 않고 재접속을 기다려주는 유예 시간.
const RECONNECT_GRACE_MS = 25000;

// 서든 데스: 경기 시작 후 이 시간이 지나면, 현재 라운드의 마지막 순번
// 플레이어 턴이 끝나는 즉시 서든 데스(7-Roll Limit)로 전환된다.
const SUDDEN_DEATH_TIME_MS = 5 * 60 * 1000;
const SUDDEN_DEATH_ROLLS = 7;

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
 *   id, players: [{ pid, socketId, nick, name, color, position, isHost, connected, disconnectTimer }],
 *   currentTurnIndex, started
 * }
 *
 * pid는 재접속 시에도 유지되는 플레이어의 고정 식별자이고, socketId는
 * 현재 연결된 소켓의 id다(재접속하면 socketId만 새 값으로 교체된다).
 * 클라이언트에게 노출되는 모든 "id" 필드는 pid를 의미한다.
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
      id: p.pid,
      nick: p.nick,
      name: p.name,
      color: p.color,
      position: p.position,
      isHost: p.isHost,
      connected: p.connected,
      rollsLeft: room.suddenDeathActive ? (p.rollsLeft != null ? p.rollsLeft : SUDDEN_DEATH_ROLLS) : null
    })),
    currentTurnIndex: room.currentTurnIndex,
    started: room.started,
    startedAt: room.startedAt || null,
    suddenDeathEnabled: !!room.suddenDeathEnabled,
    suddenDeathActive: !!room.suddenDeathActive
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

// 90칸이 넘으면(90 이상) 주사위 1개(1~6)만, 그 아래는 주사위 2개(합 2~12)를 사용한다.
const SINGLE_DIE_THRESHOLD = 90;

// 주사위 합만큼 이동 경로를 계산한다. 100칸을 넘기면 100까지 간 뒤
// 초과분만큼 다시 뒤로 되돌아온다(정확히 100에 도착해야 결승 처리).
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

// 서든 데스 중에는 남은 주사위 횟수(rollsLeft)가 있는 플레이어에게만
// 차례가 돌아가야 한다. 모두 소진했으면 -1을 반환한다.
function nextSuddenDeathIndex(room, fromIndex) {
  const n = room.players.length;
  if (n === 0) return -1;
  for (let i = 0; i < n; i++) {
    const idx = (fromIndex + i) % n;
    if ((room.players[idx].rollsLeft || 0) > 0) return idx;
  }
  return -1;
}

// 서든 데스 발동: 방장 순서부터 시작하고, 전원에게 정확히 7회의 기회를 준다.
function triggerSuddenDeath(room) {
  room.suddenDeathActive = true;
  room.players.forEach((p) => { p.rollsLeft = SUDDEN_DEATH_ROLLS; });

  const hostIndex = room.players.findIndex((p) => p.isHost);
  room.currentTurnIndex = hostIndex >= 0 ? hostIndex : 0;

  io.to(room.id).emit('suddenDeathStart', {
    message: '경기 시간 5분 경과!\n서든 데스 모드로 전환 (유저별 7회)',
    ...publicRoomState(room)
  });
}

// 서든 데스 종료: 목표점과 가장 가까운(=칸 번호가 가장 큰) 순서로 순위를 매긴다.
function endSuddenDeath(room) {
  const rankings = [...room.players]
    .sort((a, b) => b.position - a.position)
    .map((p, idx) => ({
      id: p.pid,
      nick: p.nick,
      name: p.name,
      position: p.position,
      rank: idx + 1
    }));

  const winner = rankings[0];

  io.to(room.id).emit('gameOver', {
    winnerId: winner.id,
    winnerNick: winner.nick,
    winnerName: winner.name,
    rankings,
    suddenDeath: true
  });

  room.players.forEach((p) => {
    if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
  });
  delete rooms[room.id];
}

// 재접속 유예 시간이 끝났거나(started 상태) 대기실에서 즉시 나간 경우,
// 실제로 플레이어를 방에서 제거하고 남은 플레이어들에게 알린다.
function finalizeRemoval(roomId, pid) {
  const room = rooms[roomId];
  if (!room) return;

  const leavingIndex = room.players.findIndex((p) => p.pid === pid);
  if (leavingIndex === -1) return;

  const leavingPlayer = room.players[leavingIndex];
  const wasHost = leavingPlayer.isHost;
  const wasStarted = room.started;
  room.players.splice(leavingIndex, 1);

  if (wasStarted) {
    io.to(room.id).emit('playerLeft', {
      id: leavingPlayer.pid,
      nick: leavingPlayer.nick,
      name: leavingPlayer.name
    });
  }

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

  if (room.suddenDeathActive) {
    const nextIdx = nextSuddenDeathIndex(room, room.currentTurnIndex);
    if (nextIdx === -1) {
      endSuddenDeath(room);
      return;
    }
    room.currentTurnIndex = nextIdx;
  } else {
    room.currentTurnIndex = nextAliveIndex(room, room.currentTurnIndex);
  }

  broadcastRoomUpdate(room);
  if (room.started) {
    io.to(room.id).emit('turnChanged', publicRoomState(room));
  }
}

// ---------------------------------------------------------------------------
// 소켓 이벤트
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, suddenDeathEnabled }) => {
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
      started: false,
      // 옵션 체크 해제(false)로 명시된 경우만 끄고, 그 외에는 기본값 true.
      suddenDeathEnabled: suddenDeathEnabled !== false,
      suddenDeathActive: false
    };
    rooms[roomId] = room;

    const pid = randomUUID();
    const player = {
      pid,
      socketId: socket.id,
      nick: trimmed.substring(0, 2),
      name: trimmed,
      color: PLAYER_COLORS[0],
      position: 0,
      isHost: true,
      connected: true,
      disconnectTimer: null
    };
    room.players.push(player);

    socket.data.roomId = roomId;
    socket.data.pid = pid;
    socket.join(roomId);

    socket.emit('joinedRoom', { selfId: pid, ...publicRoomState(room) });
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

    const pid = randomUUID();
    const player = {
      pid,
      socketId: socket.id,
      nick: trimmed.substring(0, 2),
      name: trimmed,
      color: PLAYER_COLORS[room.players.length % PLAYER_COLORS.length],
      position: 0,
      isHost: false,
      connected: true,
      disconnectTimer: null
    };
    room.players.push(player);

    socket.data.roomId = room.id;
    socket.data.pid = pid;
    socket.join(room.id);

    socket.emit('joinedRoom', { selfId: pid, ...publicRoomState(room) });
    broadcastRoomUpdate(room);
  });

  socket.on('rejoinRoom', ({ roomId, pid }) => {
    const room = rooms[(roomId || '').toString().trim()];
    const player = room && room.players.find((p) => p.pid === pid);

    if (!room || !player) {
      socket.emit('rejoinFailed');
      return;
    }

    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }

    player.socketId = socket.id;
    player.connected = true;
    socket.data.roomId = room.id;
    socket.data.pid = pid;
    socket.join(room.id);

    socket.emit('rejoined', { selfId: pid, ...publicRoomState(room) });
    if (room.started) {
      io.to(room.id).emit('playerReconnected', { id: pid, name: player.name });
    }
    broadcastRoomUpdate(room);
  });

  socket.on('startGame', () => {
    const room = findRoomBySocket(socket);
    if (!room || room.started) return;

    const player = room.players.find((p) => p.pid === socket.data.pid);
    if (!player || !player.isHost) return;

    room.started = true;
    room.startedAt = Date.now();
    room.currentTurnIndex = 0;
    io.to(room.id).emit('gameStarted', publicRoomState(room));
  });

  socket.on('rollDice', () => {
    const room = findRoomBySocket(socket);
    if (!room || !room.started) return;

    const currentPlayer = room.players[room.currentTurnIndex];
    if (!currentPlayer || currentPlayer.pid !== socket.data.pid) return;
    if (room.suddenDeathActive && (currentPlayer.rollsLeft || 0) <= 0) return;
    // 이전 굴림의 이동/판정 연출이 끝나기 전에 같은 턴에서 다시 굴리는 것을
    // 막는다(클라이언트는 애니메이션이 끝나면 곧바로 버튼을 다시 활성화하지만,
    // 서버의 턴 전환/서든 데스 횟수 차감은 그보다 늦게 확정되기 때문).
    if (room.rollInProgress) return;
    room.rollInProgress = true;

    const singleDie = currentPlayer.position >= SINGLE_DIE_THRESHOLD;
    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = singleDie ? null : 1 + Math.floor(Math.random() * 6);
    const sum = singleDie ? d1 : d1 + d2;

    io.to(room.id).emit('diceResult', {
      playerId: currentPlayer.pid,
      d1,
      d2,
      sum,
      singleDie
    });

    const path = calculatePath(currentPlayer.position, sum);
    const landedAt = path[path.length - 1];
    const isLadder = !!LADDERS[landedAt];
    const isSnake = !!SNAKES[landedAt];
    const slideTo = LADDERS[landedAt] || SNAKES[landedAt] || null;
    const slideType = isLadder ? 'ladder' : (isSnake ? 'snake' : null);

    setTimeout(() => {
      if (!rooms[room.id]) return; // 방이 이미 사라진 경우
      io.to(room.id).emit('movePath', {
        playerId: currentPlayer.pid,
        path,
        slideTo,
        slideType
      });

      const totalMoveMs = path.length * TICK_MS + (slideTo ? SLIDE_MS : 0);

      setTimeout(() => {
        const liveRoom = rooms[room.id];
        if (!liveRoom) return;
        liveRoom.rollInProgress = false;

        const livePlayer = liveRoom.players.find((p) => p.pid === currentPlayer.pid);
        if (!livePlayer) return;

        livePlayer.position = slideTo || landedAt;

        if (livePlayer.position === 100) {
          const rankings = [...liveRoom.players]
            .sort((a, b) => b.position - a.position)
            .map((p, idx) => ({
              id: p.pid,
              nick: p.nick,
              name: p.name,
              position: p.position,
              rank: idx + 1
            }));

          io.to(liveRoom.id).emit('gameOver', {
            winnerId: livePlayer.pid,
            winnerNick: livePlayer.nick,
            winnerName: livePlayer.name,
            rankings
          });

          // 게임이 끝난 방은 재시작 기능이 없으므로, 재접속 유예를 기다리던
          // 플레이어가 있어도 즉시 정리해서 끝난 게임으로 "이어하기"가
          // 되지 않도록 방 자체를 제거한다.
          liveRoom.players.forEach((p) => {
            if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
          });
          delete rooms[liveRoom.id];
          return;
        }

        const finishingIndex = liveRoom.players.findIndex((p) => p.pid === livePlayer.pid);

        if (liveRoom.suddenDeathActive) {
          livePlayer.rollsLeft = Math.max(0, (livePlayer.rollsLeft || 0) - 1);

          const nextIdx = nextSuddenDeathIndex(liveRoom, finishingIndex + 1);
          if (nextIdx === -1) {
            endSuddenDeath(liveRoom);
            return;
          }
          liveRoom.currentTurnIndex = nextIdx;
          io.to(liveRoom.id).emit('turnChanged', publicRoomState(liveRoom));
          return;
        }

        // 아직 서든 데스가 아니면: 5분이 지났고, 이번이 이번 라운드의 마지막
        // 순번(플레이어 배열의 마지막) 턴이었는지 확인해 발동 여부를 정한다.
        const isLastInRound = finishingIndex === liveRoom.players.length - 1;
        const elapsed = Date.now() - (liveRoom.startedAt || Date.now());

        if (liveRoom.suddenDeathEnabled && elapsed >= SUDDEN_DEATH_TIME_MS && isLastInRound) {
          triggerSuddenDeath(liveRoom);
          return;
        }

        liveRoom.currentTurnIndex = nextAliveIndex(liveRoom, finishingIndex + 1);
        io.to(liveRoom.id).emit('turnChanged', publicRoomState(liveRoom));
      }, totalMoveMs + 200);
    }, DICE_ANIM_MS);
  });

  socket.on('disconnect', () => {
    const room = findRoomBySocket(socket);
    if (!room) return;

    const pid = socket.data.pid;
    const player = room.players.find((p) => p.pid === pid);
    // socketId가 다르면 이미 재접속으로 새 소켓이 자리를 대체한 뒤이므로
    // 지금 끊긴 건 이전(낡은) 소켓일 뿐 - 무시한다.
    if (!player || player.socketId !== socket.id) return;

    // 대기실(게임 시작 전)에서는 지금처럼 곧바로 제거한다.
    if (!room.started) {
      finalizeRemoval(room.id, pid);
      return;
    }

    // 게임 진행 중에는 곧바로 제거하지 않고, 모바일 화면 잠금/네트워크
    // 전환 등으로 인한 일시적 끊김일 수 있으므로 재접속을 기다려준다.
    player.connected = false;
    io.to(room.id).emit('playerConnectionLost', { id: player.pid, name: player.name });

    const roomId = room.id;
    player.disconnectTimer = setTimeout(() => {
      finalizeRemoval(roomId, pid);
    }, RECONNECT_GRACE_MS);
  });
});

server.listen(PORT, () => {
  console.log(`Snake Dice Board Game server running on port ${PORT}`);
});
