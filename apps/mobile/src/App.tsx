import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  ActionAck,
  COLOR_META,
  DiceMode,
  DiceValue,
  DICE_VALUES,
  GameState,
  PLAYER_COLORS,
  PlayerColor,
  RoomJoinedData
} from '@dice-duo/shared';
import {
  addPlayerToGame,
  applyDiceRoll,
  applyTokenMove,
  chooseBestLegalMove,
  createInitialGameState,
  setDiceMode,
  startMatch
} from '@dice-duo/game-engine';
import { LudoBoard } from './components/LudoBoard.js';
import { DiceRoller } from './components/DiceRoller.js';
import { soundFX } from './utils/sound.js';
import { isSupabaseClientEnabled } from './utils/supabaseClient.js';

interface PublicRoomSummary {
  roomCode: string;
  playerCount: number;
  maxPlayers: number;
  hostName: string;
  isPublicMatchmaking: boolean;
}

interface MatchSummaryItem {
  id: string;
  roomCode: string;
  maxPlayers: number;
  customModeUsed: boolean;
  winnerName: string;
  winnerColor: PlayerColor;
  totalTurns: number;
  completedAt: string;
}

const STORAGE_KEYS = {
  SESSION_TOKEN: 'dice_duo_player_session_token',
  PLAYER_ID: 'dice_duo_player_id',
  PLAYER_NAME: 'dice_duo_player_name',
  LAST_ROOM_CODE: 'dice_duo_last_room_code',
  LAST_PAIRING_PIN: 'dice_duo_last_pairing_pin'
};

function getServerBaseUrl(): string {
  const envUrl = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (envUrl && envUrl.trim().length > 0) {
    return envUrl.trim().replace(/\/$/, '');
  }
  return '';
}

function getSecureLocalRandomDice(): DiceValue {
  const arr = new Uint32Array(1);
  window.crypto.getRandomValues(arr);
  return ((arr[0] % 6) + 1) as DiceValue;
}

export const App: React.FC = () => {
  // Navigation & Mode State
  const [activeTab, setActiveTab] = useState<'ONLINE' | 'LOCAL' | 'HISTORY'>('ONLINE');
  const [playMode, setPlayMode] = useState<'NONE' | 'ONLINE_ROOM' | 'LOCAL_MATCH'>('NONE');

  // Player Profile & Session
  const [playerName, setPlayerName] = useState<string>(
    () => localStorage.getItem(STORAGE_KEYS.PLAYER_NAME) || 'PlayerOne'
  );
  const [playerId, setPlayerId] = useState<string>(
    () => localStorage.getItem(STORAGE_KEYS.PLAYER_ID) || ''
  );
  const [sessionToken, setSessionToken] = useState<string>(
    () => localStorage.getItem(STORAGE_KEYS.SESSION_TOKEN) || ''
  );
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);

  // Online Room Creation / Join Form State
  const [maxPlayers, setMaxPlayers] = useState<2 | 3 | 4>(2);
  const [preferredColor, setPreferredColor] = useState<PlayerColor>('RED');
  const [isPublicMatchmaking, setIsPublicMatchmaking] = useState<boolean>(false);
  const [allowCustomTesting, setAllowCustomTesting] = useState<boolean>(true);
  const [joinCodeInput, setJoinCodeInput] = useState<string>(
    () => localStorage.getItem(STORAGE_KEYS.LAST_ROOM_CODE) || ''
  );
  const [joinConsentCustom, setJoinConsentCustom] = useState<boolean>(true);

  // Online Socket & Room State
  const socketRef = useRef<Socket | null>(null);
  const [socketConnected, setSocketConnected] = useState<boolean>(false);
  const [pairingPin, setPairingPin] = useState<string>(
    () => localStorage.getItem(STORAGE_KEYS.LAST_PAIRING_PIN) || ''
  );
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [publicRooms, setPublicRooms] = useState<PublicRoomSummary[]>([]);
  const [recentMatches, setRecentMatches] = useState<MatchSummaryItem[]>([]);

  // Local Pass & Play Config
  const [localPlayerCount, setLocalPlayerCount] = useState<2 | 3 | 4>(2);
  const [localBotFlags, setLocalBotFlags] = useState<boolean[]>([false, true, true, true]);
  const [localCustomDiceVal, setLocalCustomDiceVal] = useState<DiceValue | null>(null);

  // UI Feedback State
  const [isRollingAnim, setIsRollingAnim] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [infoToast, setInfoToast] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setInfoToast(msg);
    setTimeout(() => {
      setInfoToast((prev) => (prev === msg ? null : prev));
    }, 3200);
  }, []);

  // Initialize or refresh signed session token from backend
  const ensureSession = useCallback(
    async (customName?: string): Promise<{ token: string; sub: string } | null> => {
      const targetName = (customName ?? playerName).trim() || 'PlayerOne';
      try {
        const res = await fetch(`${getServerBaseUrl()}/api/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: targetName,
            role: 'player',
            existingToken: sessionToken || undefined
          })
        });
        const data = await res.json();
        if (data.ok && data.token && data.session?.sub) {
          localStorage.setItem(STORAGE_KEYS.SESSION_TOKEN, data.token);
          localStorage.setItem(STORAGE_KEYS.PLAYER_ID, data.session.sub);
          localStorage.setItem(STORAGE_KEYS.PLAYER_NAME, targetName);
          setSessionToken(data.token);
          setPlayerId(data.session.sub);
          return { token: data.token, sub: data.session.sub };
        }
      } catch {
        // Server might be offline in pure local mode
      }
      return null;
    },
    [playerName, sessionToken]
  );

  // Connect Socket.IO client when sessionToken is ready
  useEffect(() => {
    let active = true;

    async function setupSocket() {
      const session = await ensureSession();
      if (!active || !session) return;

      if (socketRef.current) {
        socketRef.current.disconnect();
      }

      const baseUrl = getServerBaseUrl();
      const sock = io(baseUrl || undefined, {
        auth: { token: session.token },
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000
      });

      sock.on('connect', () => {
        if (!active) return;
        setSocketConnected(true);
        // Auto-rejoin previous active online room on reconnect
        const savedRoom = localStorage.getItem(STORAGE_KEYS.LAST_ROOM_CODE);
        if (savedRoom && playMode === 'ONLINE_ROOM') {
          sock.emit(
            'room:join',
            {
              roomCode: savedRoom,
              playerName,
              consentToCustomTestingMode: true
            },
            (ack: ActionAck<RoomJoinedData>) => {
              if (ack.ok && ack.data) {
                setGameState(ack.data.state);
                setPairingPin(ack.data.pairingPin);
              }
            }
          );
        }
      });

      sock.on('disconnect', () => {
        if (!active) return;
        setSocketConnected(false);
      });

      sock.on('room:state', (nextState: GameState) => {
        if (!active) return;
        setGameState((prev) => {
          if (
            prev &&
            prev.lastDiceRoll?.id !== nextState.lastDiceRoll?.id &&
            nextState.lastDiceRoll
          ) {
            soundFX.playDiceRoll();
          }
          if (prev && prev.moveHistory.length < nextState.moveHistory.length) {
            const latestMove = nextState.moveHistory[0];
            if (latestMove?.capturedTokenIds.length) {
              soundFX.playCapture();
            } else {
              soundFX.playTokenMove();
            }
          }
          if (prev && prev.phase !== 'GAME_OVER' && nextState.phase === 'GAME_OVER') {
            soundFX.playVictory();
          }
          return nextState;
        });
      });

      socketRef.current = sock;
    }

    setupSocket();

    return () => {
      active = false;
      socketRef.current?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch public waiting rooms & recent matches periodically when on Lobby/History
  const refreshLobbyData = useCallback(async () => {
    try {
      const [roomsRes, matchesRes] = await Promise.all([
        fetch(`${getServerBaseUrl()}/api/rooms`),
        fetch(`${getServerBaseUrl()}/api/matches`)
      ]);
      if (roomsRes.ok) {
        const rData = await roomsRes.json();
        if (Array.isArray(rData.rooms)) setPublicRooms(rData.rooms);
      }
      if (matchesRes.ok) {
        const mData = await matchesRes.json();
        if (Array.isArray(mData.matches)) setRecentMatches(mData.matches);
      }
    } catch {
      // Ignore network errors when offline
    }
  }, []);

  useEffect(() => {
    if (playMode === 'NONE') {
      refreshLobbyData();
      const timer = setInterval(refreshLobbyData, 5000);
      return () => clearInterval(timer);
    }
  }, [playMode, refreshLobbyData]);

  // ==========================================================================
  // Online Multiplayer Handlers
  // ==========================================================================

  const handleCreateOnlineRoom = async () => {
    setErrorBanner(null);
    if (!socketRef.current || !socketConnected) {
      setErrorBanner('Not connected to multiplayer server. Check connection or play Local Mode.');
      return;
    }
    localStorage.setItem(STORAGE_KEYS.PLAYER_NAME, playerName.trim() || 'PlayerOne');

    socketRef.current.emit(
      'room:create',
      {
        playerName: playerName.trim() || 'PlayerOne',
        maxPlayers,
        preferredColor,
        isPublicMatchmaking,
        allowCustomTestingMode: isPublicMatchmaking ? false : allowCustomTesting
      },
      (ack: ActionAck<RoomJoinedData>) => {
        if (!ack.ok || !ack.data) {
          setErrorBanner(ack.error?.message || 'Failed to create room.');
          return;
        }
        localStorage.setItem(STORAGE_KEYS.LAST_ROOM_CODE, ack.data.roomCode);
        localStorage.setItem(STORAGE_KEYS.LAST_PAIRING_PIN, ack.data.pairingPin);
        setPlayerId(ack.data.playerId);
        setPairingPin(ack.data.pairingPin);
        setGameState(ack.data.state);
        setPlayMode('ONLINE_ROOM');
      }
    );
  };

  const handleJoinOnlineRoom = (codeToJoin?: string) => {
    setErrorBanner(null);
    const cleanCode = (codeToJoin ?? joinCodeInput).trim().toUpperCase();
    if (cleanCode.length !== 6) {
      setErrorBanner('Please enter a valid 6-character Room Code.');
      return;
    }
    if (!socketRef.current || !socketConnected) {
      setErrorBanner('Not connected to multiplayer server.');
      return;
    }

    socketRef.current.emit(
      'room:join',
      {
        roomCode: cleanCode,
        playerName: playerName.trim() || 'PlayerOne',
        preferredColor,
        consentToCustomTestingMode: joinConsentCustom
      },
      (ack: ActionAck<RoomJoinedData>) => {
        if (!ack.ok || !ack.data) {
          setErrorBanner(ack.error?.message || 'Could not join room.');
          return;
        }
        localStorage.setItem(STORAGE_KEYS.LAST_ROOM_CODE, ack.data.roomCode);
        localStorage.setItem(STORAGE_KEYS.LAST_PAIRING_PIN, ack.data.pairingPin);
        setPlayerId(ack.data.playerId);
        setPairingPin(ack.data.pairingPin);
        setGameState(ack.data.state);
        setPlayMode('ONLINE_ROOM');
      }
    );
  };

  const handleStartOnlineMatch = (fillWithBots: boolean) => {
    if (!gameState || !socketRef.current) return;
    setErrorBanner(null);
    socketRef.current.emit(
      'match:start',
      {
        roomCode: gameState.roomCode,
        fillWithBots
      },
      (ack: ActionAck<GameState>) => {
        if (!ack.ok) {
          setErrorBanner(ack.error?.message || 'Failed to start match.');
        }
      }
    );
  };

  const handleToggleOnlineConsent = (consent: boolean) => {
    if (!gameState || !socketRef.current) return;
    setErrorBanner(null);
    socketRef.current.emit(
      'match:consent_custom_mode',
      {
        roomCode: gameState.roomCode,
        consent
      },
      (ack: ActionAck<GameState>) => {
        if (!ack.ok) {
          setErrorBanner(ack.error?.message || 'Could not update consent.');
        } else {
          showToast(
            consent
              ? 'You consented to Custom Testing Mode.'
              : 'You revoked Custom Testing Mode consent (Mode set to Random).'
          );
        }
      }
    );
  };

  // ==========================================================================
  // Local Pass & Play / AI Match Handlers
  // ==========================================================================

  const handleStartLocalMatch = () => {
    setErrorBanner(null);
    let state = createInitialGameState({
      roomCode: 'LOCAL1',
      maxPlayers: localPlayerCount,
      isPublicMatchmaking: false,
      allowCustomTestingMode: true
    });

    const defaultNames = [
      playerName.trim() || 'Player 1',
      'Player 2',
      'Player 3',
      'Player 4'
    ];

    for (let i = 0; i < localPlayerCount; i++) {
      const isBot = i === 0 ? false : localBotFlags[i];
      state = addPlayerToGame(state, {
        id: `local-p${i + 1}`,
        name: isBot ? `${defaultNames[i]} (AI)` : defaultNames[i],
        isHost: i === 0,
        isBot,
        consentToCustomTestingMode: true
      }).state;
    }

    state = startMatch(state).state;
    setPlayerId('local-p1');
    setGameState(state);
    setPlayMode('LOCAL_MATCH');
  };

  // Advance local AI bot turns automatically with a natural delay
  useEffect(() => {
    if (playMode !== 'LOCAL_MATCH' || !gameState || gameState.phase === 'GAME_OVER') {
      return;
    }
    const current = gameState.players.find((p) => p.id === gameState.currentTurnPlayerId);
    if (!current || !current.isBot) return;

    const timer = setTimeout(() => {
      setGameState((prev) => {
        if (!prev || prev.phase === 'GAME_OVER') return prev;
        const bot = prev.players.find((p) => p.id === prev.currentTurnPlayerId);
        if (!bot || !bot.isBot) return prev;

        if (prev.phase === 'WAITING_FOR_ROLL') {
          const dice = getSecureLocalRandomDice();
          soundFX.playDiceRoll();
          const rolled = applyDiceRoll(prev, bot.id, dice, 'RANDOM');
          return rolled.ok ? rolled.state : prev;
        }

        if (prev.phase === 'WAITING_FOR_MOVE') {
          const best = chooseBestLegalMove(prev.legalMoves);
          if (!best) return prev;
          if (best.willCaptureTokenIds.length > 0) {
            soundFX.playCapture();
          } else {
            soundFX.playTokenMove();
          }
          const moved = applyTokenMove(prev, bot.id, best.tokenId);
          if (moved.ok && moved.state.phase === 'GAME_OVER') {
            soundFX.playVictory();
          }
          return moved.ok ? moved.state : prev;
        }
        return prev;
      });
    }, 650);

    return () => clearTimeout(timer);
  }, [playMode, gameState]);

  // ==========================================================================
  // Unified Roll & Move Dispatchers
  // ==========================================================================

  const handleRollDice = () => {
    if (!gameState || isRollingAnim) return;
    setErrorBanner(null);
    setIsRollingAnim(true);
    soundFX.playDiceRoll();

    setTimeout(() => {
      setIsRollingAnim(false);

      if (playMode === 'ONLINE_ROOM') {
        socketRef.current?.emit(
          'match:roll_dice',
          { roomCode: gameState.roomCode },
          (ack: ActionAck<GameState>) => {
            if (!ack.ok) {
              setErrorBanner(ack.error?.message || 'Roll failed.');
            }
          }
        );
        return;
      }

      // Local match roll
      const isCustom =
        gameState.customModeDisclosure.mode === 'CUSTOM_TESTING' &&
        localCustomDiceVal !== null;
      const val: DiceValue = isCustom ? localCustomDiceVal! : getSecureLocalRandomDice();
      const mode: DiceMode = isCustom ? 'CUSTOM_TESTING' : 'RANDOM';

      const res = applyDiceRoll(gameState, gameState.currentTurnPlayerId, val, mode);
      if (!res.ok) {
        setErrorBanner(res.error?.message || 'Cannot roll.');
        return;
      }
      setLocalCustomDiceVal(null);
      setGameState(res.state);
    }, 240);
  };

  const handleSelectTokenMove = (tokenId: string) => {
    if (!gameState) return;
    setErrorBanner(null);

    if (playMode === 'ONLINE_ROOM') {
      socketRef.current?.emit(
        'match:move_token',
        {
          roomCode: gameState.roomCode,
          tokenId
        },
        (ack: ActionAck<GameState>) => {
          if (!ack.ok) {
            setErrorBanner(ack.error?.message || 'Illegal token move.');
          }
        }
      );
      return;
    }

    // Local match move
    const moveObj = gameState.legalMoves.find((m) => m.tokenId === tokenId);
    if (moveObj?.willCaptureTokenIds.length) {
      soundFX.playCapture();
    } else {
      soundFX.playTokenMove();
    }
    const res = applyTokenMove(gameState, gameState.currentTurnPlayerId, tokenId);
    if (!res.ok) {
      setErrorBanner(res.error?.message || 'Illegal move.');
      return;
    }
    if (res.state.phase === 'GAME_OVER') {
      soundFX.playVictory();
    }
    setGameState(res.state);
  };

  const handleToggleLocalDiceMode = (mode: DiceMode) => {
    if (!gameState || playMode !== 'LOCAL_MATCH') return;
    const res = setDiceMode(gameState, mode, 'Local Host');
    if (res.ok) {
      setGameState(res.state);
      if (mode === 'RANDOM') setLocalCustomDiceVal(null);
    }
  };

  const handleLeaveGame = () => {
    setPlayMode('NONE');
    setGameState(null);
    setErrorBanner(null);
    refreshLobbyData();
  };

  // ==========================================================================
  // Render Active Game / Waiting Room View
  // ==========================================================================

  if (playMode !== 'NONE' && gameState) {
    const currentTurnPlayer =
      gameState.players.find((p) => p.id === gameState.currentTurnPlayerId) ??
      gameState.players[0];

    const myPlayer = gameState.players.find((p) => p.id === playerId);
    const isMyTurn =
      playMode === 'LOCAL_MATCH'
        ? !currentTurnPlayer?.isBot
        : gameState.currentTurnPlayerId === playerId;

    const canRollNow =
      gameState.phase === 'WAITING_FOR_ROLL' && Boolean(isMyTurn);
    const canMoveNow =
      gameState.phase === 'WAITING_FOR_MOVE' && Boolean(isMyTurn);

    const myConsent = myPlayer
      ? Boolean(gameState.customModeDisclosure.playerConsents[myPlayer.id])
      : false;

    return (
      <div className="app-viewport">
        {/* Top Match Bar */}
        <header className="game-topbar">
          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={handleLeaveGame}
          >
            ← Lobby
          </button>

          <div className="room-pill-group">
            <span className="room-code-badge">
              ROOM: <strong>{gameState.roomCode}</strong>
            </span>
            {playMode === 'ONLINE_ROOM' && pairingPin && (
              <span className="pin-badge" title="Smart Remote 4-digit Pairing PIN">
                PIN: <strong>{pairingPin}</strong>
              </span>
            )}
          </div>

          <button
            type="button"
            className="btn-ghost btn-sm"
            onClick={() => {
              const next = !soundEnabled;
              setSoundEnabled(next);
              soundFX.enabled = next;
            }}
            aria-label="Toggle Sound Effects"
          >
            {soundEnabled ? '🔊 SFX' : '🔇 Mute'}
          </button>
        </header>

        {/* Explicit Custom Testing Mode Disclosure Banner */}
        {gameState.customModeDisclosure.mode === 'CUSTOM_TESTING' && (
          <div className="disclosure-banner" role="alert">
            <div className="disclosure-icon">⚠️</div>
            <div className="disclosure-text">
              <strong>CUSTOM TESTING MODE ACTIVE</strong>
              <span>
                {gameState.customModeDisclosure.activeDisclosureMessage ||
                  'Authorized controller may select dice rolls 1–6. Every custom roll is tagged and visible to all players.'}
              </span>
            </div>
          </div>
        )}

        {errorBanner && (
          <div className="error-alert" role="alert">
            <span>{errorBanner}</span>
            <button
              type="button"
              className="btn-close-alert"
              onClick={() => setErrorBanner(null)}
            >
              ✕
            </button>
          </div>
        )}

        {infoToast && <div className="info-toast">{infoToast}</div>}

        {/* Waiting Room Lobby Phase */}
        {gameState.phase === 'WAITING_FOR_PLAYERS' ? (
          <main className="waiting-room-card">
            <h2>Waiting for Players ({gameState.players.length}/{gameState.maxPlayers})</h2>
            <p className="subtitle">
              Share the Room Code with other players or pair the Smart Remote controller.
            </p>

            <div className="code-showcase-grid">
              <div className="code-box">
                <span className="code-box-label">ROOM CODE</span>
                <span className="code-box-value">{gameState.roomCode}</span>
                <button
                  type="button"
                  className="btn-secondary btn-xs"
                  onClick={() => {
                    navigator.clipboard?.writeText(gameState.roomCode);
                    showToast('Room Code copied!');
                  }}
                >
                  Copy Code
                </button>
              </div>

              <div className="code-box">
                <span className="code-box-label">SMART REMOTE PIN</span>
                <span className="code-box-value">{pairingPin || '----'}</span>
                <button
                  type="button"
                  className="btn-secondary btn-xs"
                  onClick={() => {
                    navigator.clipboard?.writeText(pairingPin);
                    showToast('Pairing PIN copied!');
                  }}
                >
                  Copy PIN
                </button>
              </div>
            </div>

            <div className="remote-status-strip">
              <span>
                Smart Remote Status:{' '}
                <strong>
                  {gameState.remoteStatus.isPaired
                    ? `Paired (${gameState.remoteStatus.controllerLabel || 'Connected'})`
                    : 'Not Paired Yet'}
                </strong>
              </span>
            </div>

            <div className="players-roster">
              {gameState.players.map((p) => (
                <div key={p.id} className="roster-row">
                  <span
                    className="color-dot"
                    style={{ backgroundColor: COLOR_META[p.color].primaryHex }}
                  />
                  <span className="roster-name">
                    {p.name} {p.isHost ? '(Host)' : ''} {p.id === playerId ? '(You)' : ''}
                  </span>
                  <span className="roster-consent">
                    {gameState.customModeDisclosure.playerConsents[p.id]
                      ? '✓ Test Mode Agreed'
                      : 'Random Only'}
                  </span>
                </div>
              ))}
            </div>

            {myPlayer?.isHost ? (
              <div className="host-start-actions">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={gameState.players.length < 2}
                  onClick={() => handleStartOnlineMatch(false)}
                >
                  Start Match ({gameState.players.length}/{gameState.maxPlayers} Players)
                </button>
                {gameState.players.length < gameState.maxPlayers && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => handleStartOnlineMatch(true)}
                  >
                    Fill Empty Seats with AI Bots &amp; Start Now
                  </button>
                )}
              </div>
            ) : (
              <p className="waiting-host-note">
                Waiting for the room host to start the match...
              </p>
            )}
          </main>
        ) : (
          /* Active Match Board & HUD */
          <main className="match-layout">
            {/* 4-Player Compact Score & Status Strip */}
            <div className="player-hud-grid">
              {gameState.players.map((p) => {
                const isTurn = p.id === gameState.currentTurnPlayerId && gameState.phase !== 'GAME_OVER';
                const finishedCount = Object.values(gameState.tokens).filter(
                  (t) => t.color === p.color && t.zone === 'FINISHED'
                ).length;

                return (
                  <div
                    key={p.id}
                    className={`player-hud-chip ${isTurn ? 'player-hud-active' : ''}`}
                    style={{
                      borderColor: isTurn ? COLOR_META[p.color].primaryHex : '#1E293B'
                    }}
                  >
                    <div className="hud-chip-header">
                      <span
                        className="color-dot"
                        style={{ backgroundColor: COLOR_META[p.color].primaryHex }}
                      />
                      <span className="hud-player-name">
                        {p.name}
                        {p.id === playerId && playMode === 'ONLINE_ROOM' ? ' (You)' : ''}
                      </span>
                      {!p.isConnected && <span className="offline-tag">Offline</span>}
                    </div>
                    <div className="hud-chip-meta">
                      <span>Home: {finishedCount}/4</span>
                      <span>Captures: {p.stats.capturesMade}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 15x15 Ludo Board */}
            <LudoBoard
              state={gameState}
              canMoveNow={canMoveNow}
              onSelectToken={handleSelectTokenMove}
            />

            {/* Dice Roller & Turn Controls */}
            <DiceRoller
              value={gameState.lastDiceRoll?.value ?? null}
              mode={gameState.customModeDisclosure.mode}
              lastRollWasCustom={gameState.lastDiceRoll?.mode === 'CUSTOM_TESTING'}
              isRolling={isRollingAnim}
              canRoll={canRollNow}
              currentTurnName={currentTurnPlayer?.name ?? 'Player'}
              currentTurnColor={gameState.currentTurnColor}
              consecutiveSixes={gameState.consecutiveSixes}
              forfeitedByThreeSixes={Boolean(gameState.lastDiceRoll?.forfeitedByThreeSixes)}
              queuedCustomValue={
                playMode === 'LOCAL_MATCH'
                  ? localCustomDiceVal
                  : gameState.remoteStatus.queuedCustomValue
              }
              onRoll={handleRollDice}
            />

            {/* Online Custom Mode Consent Bar & Smart Remote Indicator */}
            {playMode === 'ONLINE_ROOM' && (
              <div className="consent-bar">
                <div className="consent-bar-info">
                  <span>
                    Smart Remote:{' '}
                    <strong>
                      {gameState.remoteStatus.isPaired
                        ? `Connected (${gameState.remoteStatus.controllerLabel || 'Remote'})`
                        : `Pair with Room ${gameState.roomCode} + PIN ${pairingPin}`}
                    </strong>
                  </span>
                </div>
                <label className="consent-toggle-label">
                  <input
                    type="checkbox"
                    checked={myConsent}
                    onChange={(e) => handleToggleOnlineConsent(e.target.checked)}
                  />
                  <span>Agree to Custom Testing Mode</span>
                </label>
              </div>
            )}

            {/* Local Mode Testing Bar (for offline testing of Custom Dice 1..6) */}
            {playMode === 'LOCAL_MATCH' && (
              <div className="local-test-panel">
                <div className="local-test-header">
                  <span>Local Dice Mode:</span>
                  <div className="segmented-btns">
                    <button
                      type="button"
                      className={`btn-seg ${
                        gameState.customModeDisclosure.mode === 'RANDOM' ? 'active' : ''
                      }`}
                      onClick={() => handleToggleLocalDiceMode('RANDOM')}
                    >
                      Random (CSPRNG)
                    </button>
                    <button
                      type="button"
                      className={`btn-seg ${
                        gameState.customModeDisclosure.mode === 'CUSTOM_TESTING'
                          ? 'active'
                          : ''
                      }`}
                      onClick={() => handleToggleLocalDiceMode('CUSTOM_TESTING')}
                    >
                      Custom Testing (1–6)
                    </button>
                  </div>
                </div>

                {gameState.customModeDisclosure.mode === 'CUSTOM_TESTING' && (
                  <div className="local-custom-dice-picker">
                    <span>Select next roll:</span>
                    {DICE_VALUES.map((v) => (
                      <button
                        key={v}
                        type="button"
                        className={`btn-dice-num ${
                          localCustomDiceVal === v ? 'selected' : ''
                        }`}
                        onClick={() => setLocalCustomDiceVal(v)}
                      >
                        {v}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="btn-ghost btn-xs"
                      onClick={() => setLocalCustomDiceVal(null)}
                    >
                      Reset
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Game Over Results Modal */}
            {gameState.phase === 'GAME_OVER' && (
              <div className="modal-backdrop" role="dialog" aria-label="Match Results">
                <div className="results-modal-card">
                  <div className="trophy-header">🏆 MATCH COMPLETE</div>
                  <h2>
                    {gameState.players.find((p) => p.id === gameState.winnerPlayerId)?.name ??
                      'Winner'}{' '}
                    Wins!
                  </h2>

                  {gameState.players.some((p) => p.stats.customRollsUsed > 0) && (
                    <div className="custom-used-note">
                      ⚠️ Match played with Custom Testing Mode rolls enabled.
                    </div>
                  )}

                  <div className="rankings-table">
                    {gameState.players
                      .slice()
                      .sort((a, b) => (a.finishedRank ?? 99) - (b.finishedRank ?? 99))
                      .map((p, idx) => (
                        <div key={p.id} className="ranking-row">
                          <span className="rank-medal">#{p.finishedRank ?? idx + 1}</span>
                          <span
                            className="color-dot"
                            style={{ backgroundColor: COLOR_META[p.color].primaryHex }}
                          />
                          <span className="rank-name">{p.name}</span>
                          <span className="rank-stats">
                            {p.stats.capturesMade} captures • {p.stats.sixesCount} sixes
                          </span>
                        </div>
                      ))}
                  </div>

                  <div className="modal-actions">
                    {playMode === 'LOCAL_MATCH' && (
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={handleStartLocalMatch}
                      >
                        Play Rematch
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={handleLeaveGame}
                    >
                      Return to Lobby
                    </button>
                  </div>
                </div>
              </div>
            )}
          </main>
        )}
      </div>
    );
  }

  // ==========================================================================
  // Render Main Home / Lobby Screen
  // ==========================================================================

  return (
    <div className="app-viewport lobby-viewport">
      <header className="brand-header">
        <div className="brand-logo-row">
          <div className="brand-crest">🎲</div>
          <div>
            <h1 className="brand-title">DICE DUO</h1>
            <p className="brand-tagline">
              Royal Tactical Ludo • Authoritative Server &amp; Smart Remote
            </p>
          </div>
        </div>

        <div className="connection-pill-row">
          <span
            className={`conn-dot ${socketConnected ? 'conn-online' : 'conn-offline'}`}
          />
          <span>
            {socketConnected ? 'Multiplayer Server Online' : 'Offline / Local Mode Ready'}
          </span>
          {isSupabaseClientEnabled && <span className="supabase-badge">Supabase Linked</span>}
        </div>
      </header>

      {errorBanner && (
        <div className="error-alert" role="alert">
          <span>{errorBanner}</span>
          <button
            type="button"
            className="btn-close-alert"
            onClick={() => setErrorBanner(null)}
          >
            ✕
          </button>
        </div>
      )}

      {/* Mode Navigation Tabs */}
      <nav className="lobby-tabs" aria-label="Game Modes">
        <button
          type="button"
          className={`lobby-tab ${activeTab === 'ONLINE' ? 'active' : ''}`}
          onClick={() => setActiveTab('ONLINE')}
        >
          🌐 Online Multiplayer
        </button>
        <button
          type="button"
          className={`lobby-tab ${activeTab === 'LOCAL' ? 'active' : ''}`}
          onClick={() => setActiveTab('LOCAL')}
        >
          📱 Pass &amp; Play / AI
        </button>
        <button
          type="button"
          className={`lobby-tab ${activeTab === 'HISTORY' ? 'active' : ''}`}
          onClick={() => {
            setActiveTab('HISTORY');
            refreshLobbyData();
          }}
        >
          🏆 Match History
        </button>
      </nav>

      {/* Player Identity Card */}
      <section className="lobby-card identity-card">
        <label htmlFor="player-name-input" className="field-label">
          Your Display Name
        </label>
        <div className="identity-row">
          <input
            id="player-name-input"
            type="text"
            className="text-input"
            value={playerName}
            maxLength={24}
            placeholder="Enter player name"
            onChange={(e) => setPlayerName(e.target.value)}
          />
          <div className="color-picker-inline" role="radiogroup" aria-label="Preferred Color">
            {PLAYER_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={color}
                className={`color-swatch-btn ${
                  preferredColor === color ? 'selected' : ''
                }`}
                style={{ backgroundColor: COLOR_META[color].primaryHex }}
                onClick={() => setPreferredColor(color)}
              />
            ))}
          </div>
        </div>
      </section>

      {activeTab === 'ONLINE' && (
        <div className="lobby-grid">
          {/* Create Room Card */}
          <section className="lobby-card">
            <h2>Create Multiplayer Room</h2>
            <p className="card-desc">
              Host a 2–4 player room with an instant Room Code and 4-digit Smart Remote Pairing PIN.
            </p>

            <div className="form-group">
              <span className="field-label">Players Count</span>
              <div className="segmented-btns">
                {([2, 3, 4] as const).map((cnt) => (
                  <button
                    key={cnt}
                    type="button"
                    className={`btn-seg ${maxPlayers === cnt ? 'active' : ''}`}
                    onClick={() => setMaxPlayers(cnt)}
                  >
                    {cnt} Players
                  </button>
                ))}
              </div>
            </div>

            <div className="form-check-list">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={isPublicMatchmaking}
                  onChange={(e) => {
                    const pub = e.target.checked;
                    setIsPublicMatchmaking(pub);
                    if (pub) setAllowCustomTesting(false);
                  }}
                />
                <span>Public Matchmaking Room (disables Custom Mode by default)</span>
              </label>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={allowCustomTesting}
                  disabled={isPublicMatchmaking}
                  onChange={(e) => setAllowCustomTesting(e.target.checked)}
                />
                <span>
                  Allow Smart Remote Custom Testing Mode (requires all players&apos; consent)
                </span>
              </label>
            </div>

            <button
              type="button"
              className="btn-primary btn-block"
              onClick={handleCreateOnlineRoom}
            >
              Create Room &amp; Get Code
            </button>
          </section>

          {/* Join Room Card */}
          <section className="lobby-card">
            <h2>Join Existing Room</h2>
            <p className="card-desc">
              Enter a 6-character Room Code or pick an open room below.
            </p>

            <div className="join-input-row">
              <input
                type="text"
                className="text-input code-input"
                placeholder="6-CHAR CODE"
                maxLength={6}
                value={joinCodeInput}
                onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
              />
              <button
                type="button"
                className="btn-primary"
                onClick={() => handleJoinOnlineRoom()}
              >
                Join
              </button>
            </div>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={joinConsentCustom}
                onChange={(e) => setJoinConsentCustom(e.target.checked)}
              />
              <span>I consent to Smart Remote Custom Testing Mode in this room</span>
            </label>

            {publicRooms.length > 0 && (
              <div className="open-rooms-list">
                <span className="field-label">Open Waiting Rooms</span>
                {publicRooms.map((r) => (
                  <div key={r.roomCode} className="open-room-item">
                    <div>
                      <strong>{r.roomCode}</strong> • Host: {r.hostName} ({r.playerCount}/
                      {r.maxPlayers})
                    </div>
                    <button
                      type="button"
                      className="btn-secondary btn-xs"
                      onClick={() => handleJoinOnlineRoom(r.roomCode)}
                    >
                      Join
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {activeTab === 'LOCAL' && (
        <section className="lobby-card">
          <h2>Local Pass &amp; Play / AI Practice</h2>
          <p className="card-desc">
            Play immediately on one Android device against friends or tactical AI bots. Includes a built-in Custom Testing Mode bar.
          </p>

          <div className="form-group">
            <span className="field-label">Total Players</span>
            <div className="segmented-btns">
              {([2, 3, 4] as const).map((cnt) => (
                <button
                  key={cnt}
                  type="button"
                  className={`btn-seg ${localPlayerCount === cnt ? 'active' : ''}`}
                  onClick={() => setLocalPlayerCount(cnt)}
                >
                  {cnt} Players
                </button>
              ))}
            </div>
          </div>

          <div className="local-seats-config">
            {Array.from({ length: localPlayerCount }).map((_, idx) => (
              <div key={idx} className="seat-config-row">
                <span>Seat #{idx + 1}</span>
                {idx === 0 ? (
                  <span className="seat-tag">Human ({playerName || 'You'})</span>
                ) : (
                  <button
                    type="button"
                    className="btn-secondary btn-xs"
                    onClick={() =>
                      setLocalBotFlags((prev) => {
                        const copy = [...prev];
                        copy[idx] = !copy[idx];
                        return copy;
                      })
                    }
                  >
                    {localBotFlags[idx] ? '🤖 Smart AI Bot' : '👤 Human Pass & Play'}
                  </button>
                )}
              </div>
            ))}
          </div>

          <button
            type="button"
            className="btn-primary btn-block"
            onClick={handleStartLocalMatch}
          >
            Launch Local Ludo Match
          </button>
        </section>
      )}

      {activeTab === 'HISTORY' && (
        <section className="lobby-card">
          <h2>Recent Completed Matches</h2>
          {recentMatches.length === 0 ? (
            <p className="empty-state-text">
              No completed matches recorded yet. Finish a match to see rankings and stats here!
            </p>
          ) : (
            <div className="history-list">
              {recentMatches.map((m) => (
                <div key={m.id} className="history-item">
                  <div className="history-item-main">
                    <span
                      className="color-dot"
                      style={{ backgroundColor: COLOR_META[m.winnerColor].primaryHex }}
                    />
                    <strong>{m.winnerName}</strong> won in {m.totalTurns} turns
                  </div>
                  <div className="history-item-meta">
                    <span>Room {m.roomCode}</span>
                    {m.customModeUsed && (
                      <span className="mode-pill mode-pill-custom">Custom Mode</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
};
