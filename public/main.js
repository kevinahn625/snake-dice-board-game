// main.js
(function () {
  'use strict';

  // -------------------------------------------------------------------
  // 1~100번 칸의 X, Y(%) 좌표 매핑 딕셔너리
  // 좌하단(1) 시작 -> 지그재그(ㄹ자)로 올라가 좌상단(100) 종료
  //
  // board.png는 정사각형이 아니라 520x758(가로:세로) 이미지이며, 상단
  // 약 15.7%는 실제 칸이 아닌 제목 배너 영역이다. .board 컨테이너의
  // aspect-ratio를 520/758로 맞춰 이미지가 레터박스 없이 꽉 차도록 한 뒤,
  // 실측한 격자 영역의 픽셀 경계(좌4, 우515, 상119, 하752)를 %로 환산해
  // 그 안에서만 10x10 칸 중심 좌표를 계산한다.
  // -------------------------------------------------------------------
  const IMG_W = 520;
  const IMG_H = 758;
  const GRID_LEFT_PCT = (4 / IMG_W) * 100;
  const GRID_RIGHT_PCT = (515 / IMG_W) * 100;
  const GRID_TOP_PCT = (119 / IMG_H) * 100;
  const GRID_BOTTOM_PCT = (752 / IMG_H) * 100;
  const GRID_W_PCT = GRID_RIGHT_PCT - GRID_LEFT_PCT;
  const GRID_H_PCT = GRID_BOTTOM_PCT - GRID_TOP_PCT;

  const BOARD_POSITIONS = {};
  (function buildBoardPositions() {
    const cellW = GRID_W_PCT / 10;
    const cellH = GRID_H_PCT / 10;
    for (let p = 1; p <= 100; p++) {
      const row = Math.floor((p - 1) / 10);        // 0(맨 아래) ~ 9(맨 위)
      const colInRow = (p - 1) % 10;                 // 0 ~ 9
      const isEvenRow = row % 2 === 0;
      const col = isEvenRow ? colInRow : 9 - colInRow;
      const rowFromTop = 9 - row;                     // 0(맨 위) ~ 9(맨 아래)
      const x = GRID_LEFT_PCT + (col + 0.5) * cellW;
      const y = GRID_TOP_PCT + (rowFromTop + 0.5) * cellH;
      BOARD_POSITIONS[p] = { x, y };
    }
  })();

  const TICK_MS = 250;
  const SLIDE_MS = 400;
  const DICE_ANIM_MS = 700;

  // -------------------------------------------------------------------
  // 상태
  // -------------------------------------------------------------------
  let socket = null;
  let selfId = null;
  let currentRoom = null; // 서버에서 받은 최신 roomState
  let isAnimating = false;

  // -------------------------------------------------------------------
  // 사운드 엔진 (Web Audio API로 배경음악/효과음을 직접 합성해 재생)
  // 별도 오디오 파일 없이 동작하도록 오실레이터로 소리를 만든다.
  // -------------------------------------------------------------------
  const Sound = (function () {
    let ctx = null;
    let muted = false;
    let bgmTimer = null;
    let bgmStep = 0;

    // 배경음악은 public/bgm.mp3 파일을 그대로 재생한다.
    // (파일이 없으면 자동으로 합성 멜로디로 대체된다.)
    const bgmAudio = document.getElementById('bgmAudio');
    bgmAudio.volume = 0.35;
    let bgmFileFailed = false;
    bgmAudio.addEventListener('error', () => { bgmFileFailed = true; });

    // 밝고 경쾌한 8마디 반복 멜로디 (도-미-솔 위주의 장조 진행) - bgm.mp3가 없을 때의 대체용
    const MELODY = [523.25, 659.25, 783.99, 659.25, 523.25, 659.25, 987.77, 783.99];
    const BASS = [130.81, 0, 164.81, 0, 130.81, 0, 196.00, 0];
    const STEP_MS = 260;

    function ensureCtx() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }

    // 브라우저 자동재생 정책 때문에 사용자의 첫 클릭 안에서 한 번
    // 재생을 시도해둬야 이후 startBgm()의 play()가 막히지 않는다.
    function unlockBgmAudio() {
      const p = bgmAudio.play();
      if (p && p.catch) {
        p.then(() => bgmAudio.pause()).catch(() => {});
      }
    }

    function tone(freq, startDelay, duration, opts) {
      if (muted || !freq) return;
      const c = ensureCtx();
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = (opts && opts.type) || 'triangle';
      o.frequency.setValueAtTime(freq, c.currentTime + startDelay);
      if (opts && opts.slideTo) {
        o.frequency.exponentialRampToValueAtTime(
          Math.max(opts.slideTo, 1),
          c.currentTime + startDelay + duration
        );
      }
      const peak = (opts && opts.gain) || 0.12;
      g.gain.setValueAtTime(0.0001, c.currentTime + startDelay);
      g.gain.exponentialRampToValueAtTime(peak, c.currentTime + startDelay + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + startDelay + duration);
      o.connect(g).connect(c.destination);
      o.start(c.currentTime + startDelay);
      o.stop(c.currentTime + startDelay + duration + 0.02);
    }

    function playLadder() {
      // 위로 올라가는 경쾌한 상승 아르페지오
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        tone(f, i * 0.07, 0.16, { type: 'triangle', gain: 0.14 });
      });
    }

    function playSnake() {
      // 아래로 굴러 떨어지는 하강 글리산도 + 바닥에 닿는 둔탁한 소리
      tone(700, 0, 0.4, { type: 'sawtooth', gain: 0.1, slideTo: 120 });
      tone(90, 0.38, 0.15, { type: 'sine', gain: 0.18 });
    }

    function bgmTick() {
      if (muted) return;
      const i = bgmStep % MELODY.length;
      tone(MELODY[i], 0, STEP_MS / 1000 * 0.9, { type: 'square', gain: 0.05 });
      if (BASS[i]) tone(BASS[i], 0, STEP_MS / 1000 * 0.9, { type: 'sine', gain: 0.06 });
      bgmStep++;
    }

    function startSynthBgm() {
      if (bgmTimer) return;
      ensureCtx();
      bgmStep = 0;
      bgmTick();
      bgmTimer = setInterval(bgmTick, STEP_MS);
    }

    function stopSynthBgm() {
      if (bgmTimer) {
        clearInterval(bgmTimer);
        bgmTimer = null;
      }
    }

    function startBgm() {
      if (muted) return;
      if (bgmFileFailed) {
        startSynthBgm();
        return;
      }
      const p = bgmAudio.play();
      if (p && p.catch) {
        p.catch(() => {
          // mp3 재생이 막혔거나 파일이 없으면 합성 멜로디로 대체
          startSynthBgm();
        });
      }
    }

    function stopBgm() {
      bgmAudio.pause();
      bgmAudio.currentTime = 0;
      stopSynthBgm();
    }

    function setMuted(v) {
      muted = v;
      bgmAudio.muted = v;
      if (muted) stopSynthBgm();
    }

    return {
      unlock: () => { ensureCtx(); unlockBgmAudio(); },
      playLadder,
      playSnake,
      startBgm,
      stopBgm,
      setMuted,
      isMuted: () => muted
    };
  })();

  // -------------------------------------------------------------------
  // DOM 참조
  // -------------------------------------------------------------------
  const nameModal = document.getElementById('nameModal');
  const nameInput = document.getElementById('nameInput');
  const createRoomBtn = document.getElementById('createRoomBtn');
  const roomCodeInput = document.getElementById('roomCodeInput');
  const joinRoomBtn = document.getElementById('joinRoomBtn');
  const modalError = document.getElementById('modalError');

  const lobbyScreen = document.getElementById('lobbyScreen');
  const roomCodeDisplay = document.getElementById('roomCodeDisplay');
  const playerList = document.getElementById('playerList');
  const startGameBtn = document.getElementById('startGameBtn');
  const waitHostText = document.getElementById('waitHostText');

  const gameScreen = document.getElementById('gameScreen');
  const turnIndicator = document.getElementById('turnIndicator');
  const dice1El = document.getElementById('dice1');
  const dice2El = document.getElementById('dice2');
  const tokenLayer = document.getElementById('tokenLayer');
  const rollDiceBtn = document.getElementById('rollDiceBtn');

  const winModal = document.getElementById('winModal');
  const winTitle = document.getElementById('winTitle');
  const winMessage = document.getElementById('winMessage');
  const rankList = document.getElementById('rankList');
  const reloadBtn = document.getElementById('reloadBtn');

  const muteBtn = document.getElementById('muteBtn');

  // -------------------------------------------------------------------
  // 화면 전환 헬퍼
  // -------------------------------------------------------------------
  function showError(msg) {
    modalError.textContent = msg;
  }

  function switchToLobby() {
    nameModal.classList.add('hidden');
    gameScreen.classList.add('hidden');
    lobbyScreen.classList.remove('hidden');
  }

  function switchToGame() {
    lobbyScreen.classList.add('hidden');
    winModal.classList.add('hidden');
    gameScreen.classList.remove('hidden');
  }

  // -------------------------------------------------------------------
  // 소켓 연결 및 이벤트 바인딩
  // -------------------------------------------------------------------
  function ensureSocket() {
    if (socket) return;
    socket = io();

    socket.on('errorMsg', (msg) => {
      showError(msg);
      window.alert(msg);
    });

    socket.on('joinedRoom', (state) => {
      selfId = state.selfId;
      currentRoom = state;
      renderLobby();
      switchToLobby();
    });

    socket.on('roomUpdate', (state) => {
      if (!currentRoom) return;
      currentRoom = state;
      if (!currentRoom.started) {
        renderLobby();
      }
    });

    socket.on('gameStarted', (state) => {
      currentRoom = state;
      switchToGame();
      renderBoardTokens();
      renderTurn();
      Sound.startBgm();
    });

    socket.on('diceResult', (data) => {
      playDiceAnimation(data.d1, data.d2);
    });

    socket.on('movePath', (data) => {
      animateMove(data.playerId, data.path, data.slideTo, data.slideType);
    });

    socket.on('turnChanged', (state) => {
      currentRoom = state;
      renderTurn();
    });

    socket.on('gameOver', (data) => {
      Sound.stopBgm();
      showWinModal(data);
    });
  }

  // -------------------------------------------------------------------
  // 초기 모달 이벤트
  // -------------------------------------------------------------------
  createRoomBtn.addEventListener('click', () => {
    Sound.unlock();
    const name = nameInput.value.trim();
    if (!name) {
      showError('이름을 입력해주세요.');
      return;
    }
    showError('');
    ensureSocket();
    socket.emit('createRoom', { name });
  });

  joinRoomBtn.addEventListener('click', () => {
    Sound.unlock();
    const name = nameInput.value.trim();
    const roomId = roomCodeInput.value.trim();
    if (!name) {
      showError('이름을 입력해주세요.');
      return;
    }
    if (!roomId) {
      showError('방 코드를 입력해주세요.');
      return;
    }
    showError('');
    ensureSocket();
    socket.emit('joinRoom', { name, roomId });
  });

  muteBtn.addEventListener('click', () => {
    const nextMuted = !Sound.isMuted();
    Sound.setMuted(nextMuted);
    muteBtn.textContent = nextMuted ? '🔇' : '🔊';
    if (!nextMuted && currentRoom && currentRoom.started) {
      Sound.startBgm();
    }
  });

  startGameBtn.addEventListener('click', () => {
    socket.emit('startGame');
  });

  reloadBtn.addEventListener('click', () => {
    window.location.reload();
  });

  rollDiceBtn.addEventListener('click', () => {
    if (isAnimating) return;
    socket.emit('rollDice');
  });

  // -------------------------------------------------------------------
  // 대기실 렌더링
  // -------------------------------------------------------------------
  function renderLobby() {
    roomCodeDisplay.textContent = currentRoom.roomId;
    playerList.innerHTML = '';

    currentRoom.players.forEach((p) => {
      const li = document.createElement('li');

      const dot = document.createElement('span');
      dot.className = 'player-dot';
      dot.style.background = p.color;

      const nameSpan = document.createElement('span');
      nameSpan.textContent = p.name;

      li.appendChild(dot);
      li.appendChild(nameSpan);

      if (p.isHost) {
        const badge = document.createElement('span');
        badge.className = 'host-badge';
        badge.textContent = '방장';
        li.appendChild(badge);
      }

      playerList.appendChild(li);
    });

    const self = currentRoom.players.find((p) => p.id === selfId);
    const amHost = !!(self && self.isHost);

    startGameBtn.textContent = currentRoom.players.length >= 2
      ? '게임 시작 (같이하기)'
      : '게임 시작 (혼자하기)';

    startGameBtn.classList.toggle('hidden', !amHost);
    waitHostText.classList.toggle('hidden', amHost);
  }

  // -------------------------------------------------------------------
  // 게임판 / 말 렌더링
  // -------------------------------------------------------------------
  function getPlayerById(id) {
    return currentRoom.players.find((p) => p.id === id);
  }

  function renderBoardTokens() {
    tokenLayer.innerHTML = '';
    currentRoom.players.forEach((p) => {
      const el = document.createElement('div');
      el.className = 'token';
      el.id = 'token-' + p.id;
      el.style.background = p.color;
      el.textContent = p.nick;
      positionToken(el, p.position, p.id);
      tokenLayer.appendChild(el);
    });
  }

  // 같은 칸에 여러 말이 겹칠 때 살짝 오프셋을 주어 나란히 보이게 한다.
  function positionToken(el, position, playerId) {
    if (position <= 0) {
      // 아직 보드에 오르지 않은 말은 시작칸(1) 바로 아래쪽에 대기시킨다.
      const start = BOARD_POSITIONS[1];
      const waiting = currentRoom.players.filter((p) => p.position <= 0);
      const wIdx = waiting.findIndex((p) => p.id === playerId);
      const wOff = getOffsetsForCount(waiting.length)[wIdx] || { dx: 0, dy: 0 };
      el.style.left = (start.x + wOff.dx) + '%';
      el.style.top = Math.min(start.y + 5 + wOff.dy, GRID_BOTTOM_PCT + 2) + '%';
      return;
    }

    const coord = BOARD_POSITIONS[position];
    const sameCell = currentRoom.players.filter((p) => p.position === position);
    const idx = sameCell.findIndex((p) => p.id === playerId);
    const count = sameCell.length;

    const offsets = getOffsetsForCount(count);
    const off = offsets[idx] || { dx: 0, dy: 0 };

    el.style.left = (coord.x + off.dx) + '%';
    el.style.top = (coord.y + off.dy) + '%';
  }

  function getOffsetsForCount(count) {
    const spread = 3.2;
    if (count <= 1) return [{ dx: 0, dy: 0 }];
    if (count === 2) return [{ dx: -spread, dy: 0 }, { dx: spread, dy: 0 }];
    if (count === 3) {
      return [
        { dx: -spread, dy: -spread },
        { dx: spread, dy: -spread },
        { dx: 0, dy: spread }
      ];
    }
    return [
      { dx: -spread, dy: -spread },
      { dx: spread, dy: -spread },
      { dx: -spread, dy: spread },
      { dx: spread, dy: spread }
    ];
  }

  function refreshAllTokenPositions() {
    currentRoom.players.forEach((p) => {
      const el = document.getElementById('token-' + p.id);
      if (el) positionToken(el, p.position, p.id);
    });
  }

  // -------------------------------------------------------------------
  // 턴 표시 / 주사위 버튼
  // -------------------------------------------------------------------
  function renderTurn() {
    const current = currentRoom.players[currentRoom.currentTurnIndex];
    if (!current) return;

    const isMyTurn = current.id === selfId;

    if (isMyTurn) {
      turnIndicator.textContent = '당신의 차례입니다! 주사위를 굴려주세요';
      turnIndicator.classList.add('my-turn');
    } else {
      turnIndicator.textContent = `${current.name}님의 차례 (상대방 턴 대기 중)`;
      turnIndicator.classList.remove('my-turn');
    }

    rollDiceBtn.disabled = !isMyTurn || isAnimating;
  }

  // -------------------------------------------------------------------
  // 주사위 애니메이션
  // -------------------------------------------------------------------
  function playDiceAnimation(finalD1, finalD2) {
    isAnimating = true;
    rollDiceBtn.disabled = true;

    dice1El.classList.add('rolling');
    dice2El.classList.add('rolling');

    const spinTimer = setInterval(() => {
      dice1El.textContent = String(1 + Math.floor(Math.random() * 6));
      dice2El.textContent = String(1 + Math.floor(Math.random() * 6));
    }, 80);

    setTimeout(() => {
      clearInterval(spinTimer);
      dice1El.classList.remove('rolling');
      dice2El.classList.remove('rolling');
      dice1El.textContent = String(finalD1);
      dice2El.textContent = String(finalD2);
    }, DICE_ANIM_MS);
  }

  // -------------------------------------------------------------------
  // 말 이동 애니메이션 (0.25초 간격 한 칸씩 + 뱀/파이프 슬라이드)
  // -------------------------------------------------------------------
  function animateMove(playerId, path, slideTo, slideType) {
    const player = getPlayerById(playerId);
    const el = document.getElementById('token-' + playerId);
    if (!player || !el) return;

    isAnimating = true;
    rollDiceBtn.disabled = true;

    let i = 0;
    const stepTimer = setInterval(() => {
      const pos = path[i];
      player.position = pos;
      positionToken(el, pos, playerId);
      resolveOverlapsFor(pos);

      i++;
      if (i >= path.length) {
        clearInterval(stepTimer);

        if (slideTo) {
          setTimeout(() => {
            const animClass = slideType === 'snake' ? 'tumbling' : 'rising';
            if (slideType === 'snake') {
              Sound.playSnake();
            } else {
              Sound.playLadder();
            }
            el.classList.add(animClass);

            player.position = slideTo;
            positionToken(el, slideTo, playerId);
            resolveOverlapsFor(slideTo);

            setTimeout(() => {
              el.classList.remove(animClass);
              isAnimating = false;
              renderTurn();
            }, SLIDE_MS);
          }, 150);
        } else {
          isAnimating = false;
          renderTurn();
        }
      }
    }, TICK_MS);
  }

  // 이동 중간에 같은 칸에 다른 말이 있을 경우 오프셋을 재계산해준다.
  function resolveOverlapsFor(position) {
    currentRoom.players
      .filter((p) => p.position === position)
      .forEach((p) => {
        const el = document.getElementById('token-' + p.id);
        if (el) positionToken(el, position, p.id);
      });
  }

  // -------------------------------------------------------------------
  // 승리 모달
  // -------------------------------------------------------------------
  function showWinModal(data) {
    const isMe = data.winnerId === selfId;
    winTitle.textContent = isMe ? '🎉 승리했습니다! 🎉' : '🎉 게임 종료 🎉';
    winMessage.textContent = `${data.winnerName}(${data.winnerNick})님이 결승선에 도착했습니다!`;

    rankList.innerHTML = '';
    (data.rankings || []).forEach((r) => {
      const li = document.createElement('li');
      li.className = 'rank-item' + (r.id === selfId ? ' self' : '');

      const badge = document.createElement('span');
      badge.className = 'rank-badge';
      badge.textContent = `${r.rank}위`;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'rank-name';
      nameSpan.textContent = `${r.name}(${r.nick})`;

      const posSpan = document.createElement('span');
      posSpan.className = 'rank-pos';
      posSpan.textContent = `${r.position}칸`;

      li.appendChild(badge);
      li.appendChild(nameSpan);
      li.appendChild(posSpan);
      rankList.appendChild(li);
    });

    winModal.classList.remove('hidden');
  }

  window.addEventListener('resize', () => {
    if (currentRoom && !gameScreen.classList.contains('hidden')) {
      refreshAllTokenPositions();
    }
  });
})();
