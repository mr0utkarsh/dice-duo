import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  ActionAck,
  COLOR_META,
  DiceMode,
  DiceValue,
  DICE_VALUES,
  GameState,
  RemotePairedData
} from '@dice-duo/shared';

const REMOTE_STORAGE = {
  SESSION_TOKEN: 'dice_duo_remote_session_token',
  CONTROLLER_LABEL: 'dice_duo_remote_label',
  LAST_ROOM_CODE: 'dice_duo_remote_room_code',
  LAST_PIN: 'dice_duo_remote_pin'
};

const PIP_COORDS: Record<DiceValue, Array<[number, number]>> = {
  1: [[50, 50]],
  2: [
    [28, 28],
    [72, 72]
  ],
  3: [
    [26, 26],
    [50, 50],
    [74, 74]
  ],
  4: [
    [28, 28],
    [72, 28],
    [28, 72],
    [72, 72]
  ],
  5: [
    [26, 26],
    [74, 26],
    [50, 50],
    [26, 74],
    [74, 74]
  ],
  6: [
    [28, 24],
    [72, 24],
    [28, 50],
    [72, 50],
    [28, 76],
    [72, 76]
  ]
};

function getServerBaseUrl(): string {
  const envUrl = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (envUrl && envUrl.trim().length > 0) {
    return envUrl.trim().replace(/\/$/, '');
  }
  return '';
}

export const App: React.FC = () => {
  const socketRef = useRef<Socket | null>(null);

  const [controllerLabel, setControllerLabel] = useState<string>(
    () => localStorage.getItem(REMOTE_STORAGE.CONTROLLER_LABEL) || 'QA Smart Remote'
  );
  const [roomCodeInput, setRoomCodeInput] = useState<string>(
    () => localStorage.getItem(REMOTE_STORAGE.LAST_ROOM_CODE) || ''
  );
  const [pairingPinInput, setPairingPinInput] = useState<string>(
    () => localStorage.getItem(REMOTE_STORAGE.LAST_PIN) || ''
  );

  const [connectionState, setConnectionState] = useState<
    'CONNECTING' | 'CONNECTED' | 'DISCONNECTED'
  >('CONNECTING');
  const [sessionId, setSessionId] = useState<string>('');
  const [pairedRoomCode, setPairedRoomCode] = useState<string | null>(null);
  const [gameState, setGameState] = useState<GameState | null>(null);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const flashStatus = useCallback((msg: string) => {
    setStatusMessage(msg);
    setTimeout(() => {
      setStatusMessage((prev) => (prev === msg ? null : prev));
    }, 3000);
  }, []);

  // Initialize authenticated remote session & Socket.IO connection
  useEffect(() => {
    let active = true;

    async function initRemoteSocket() {
      try {
        const existingToken =
          localStorage.getItem(REMOTE_STORAGE.SESSION_TOKEN) || undefined;
        const res = await fetch(`${getServerBaseUrl()}/api/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: controllerLabel.trim() || 'Smart Remote',
            role: 'remote',
            existingToken
          })
        });
        const data = await res.json();
        if (!active) return;

        if (!data.ok || !data.token) {
          setConnectionState('DISCONNECTED');
          setErrorMessage('Failed to authenticate Smart Remote session with server.');
          return;
        }

        localStorage.setItem(REMOTE_STORAGE.SESSION_TOKEN, data.token);
        setSessionId(data.session?.sub || 'remote');

        const sock = io(getServerBaseUrl() || undefined, {
          auth: { token: data.token },
          reconnection: true,
          reconnectionAttempts: 15,
          reconnectionDelay: 1000
        });

        sock.on('connect', () => {
          if (!active) return;
          setConnectionState('CONNECTED');
          setErrorMessage(null);
        });

        sock.on('disconnect', () => {
          if (!active) return;
          setConnectionState('DISCONNECTED');
        });

        sock.on('connect_error', (err) => {
          if (!active) return;
          setConnectionState('DISCONNECTED');
          setErrorMessage(`Socket connection error: ${err.message}`);
        });

        sock.on('room:state', (nextState: GameState) => {
          if (!active) return;
          setGameState(nextState);
        });

        socketRef.current = sock;
      } catch {
        if (!active) return;
        setConnectionState('DISCONNECTED');
        setErrorMessage('Cannot reach DICE DUO server. Ensure the backend server is running.');
      }
    }

    initRemoteSocket();

    return () => {
      active = false;
      socketRef.current?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePairRoom = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const cleanCode = roomCodeInput.trim().toUpperCase();
    const cleanPin = pairingPinInput.trim();

    if (!/^[A-Z0-9]{6}$/.test(cleanCode)) {
      setErrorMessage('Room Code must be exactly 6 alphanumeric characters.');
      return;
    }
    if (cleanPin && !/^[0-9]{4,6}$/.test(cleanPin)) {
      setErrorMessage('Pairing PIN must be 4 digits.');
      return;
    }
    if (!socketRef.current || connectionState !== 'CONNECTED') {
      setErrorMessage('Smart Remote is not connected to the server.');
      return;
    }

    localStorage.setItem(REMOTE_STORAGE.CONTROLLER_LABEL, controllerLabel.trim());

    socketRef.current.emit(
      'remote:pair',
      {
        roomCode: cleanCode,
        pairingPin: cleanPin || undefined,
        controllerLabel: controllerLabel.trim() || 'Smart Remote'
      },
      (ack: ActionAck<RemotePairedData>) => {
        if (!ack.ok || !ack.data) {
          setErrorMessage(ack.error?.message || 'Failed to pair with room.');
          return;
        }
        localStorage.setItem(REMOTE_STORAGE.LAST_ROOM_CODE, ack.data.roomCode);
        if (cleanPin) {
          localStorage.setItem(REMOTE_STORAGE.LAST_PIN, cleanPin);
        }
        setPairedRoomCode(ack.data.roomCode);
        setGameState(ack.data.state);
        flashStatus(`Paired to Room ${ack.data.roomCode}`);
      }
    );
  };

  const handleSwitchMode = (targetMode: DiceMode) => {
    if (!pairedRoomCode || !socketRef.current) return;
    setErrorMessage(null);

    socketRef.current.emit(
      'remote:set_mode',
      {
        roomCode: pairedRoomCode,
        mode: targetMode
      },
      (ack: ActionAck<GameState>) => {
        if (!ack.ok || !ack.data) {
          setErrorMessage(
            ack.error?.message || `Could not switch mode to ${targetMode}.`
          );
          return;
        }
        setGameState(ack.data);
        flashStatus(
          targetMode === 'CUSTOM_TESTING'
            ? 'Custom Testing Mode enabled & disclosed to all players.'
            : 'Switched to Cryptographically Secure Random Mode.'
        );
      }
    );
  };

  const handleSelectDiceValue = (val: DiceValue) => {
    if (!pairedRoomCode || !socketRef.current) return;
    setErrorMessage(null);

    socketRef.current.emit(
      'remote:set_dice',
      {
        roomCode: pairedRoomCode,
        value: val
      },
      (ack: ActionAck<GameState>) => {
        if (!ack.ok || !ack.data) {
          setErrorMessage(
            ack.error?.message ||
              'Cannot select custom dice value. Ensure Custom Testing Mode is active and all players consented.'
          );
          return;
        }
        setGameState(ack.data);
        flashStatus(`Selected dice value ${val} queued for next roll.`);
      }
    );
  };

  const handleResetSelection = () => {
    if (!pairedRoomCode || !socketRef.current) return;
    setErrorMessage(null);

    socketRef.current.emit(
      'remote:reset_dice',
      {
        roomCode: pairedRoomCode
      },
      (ack: ActionAck<GameState>) => {
        if (!ack.ok || !ack.data) {
          setErrorMessage(ack.error?.message || 'Failed to reset dice selection.');
          return;
        }
        setGameState(ack.data);
        flashStatus('Custom dice selection cleared.');
      }
    );
  };

  const handleTriggerRemoteRoll = () => {
    if (!pairedRoomCode || !socketRef.current) return;
    setErrorMessage(null);

    socketRef.current.emit(
      'remote:trigger_roll',
      {
        roomCode: pairedRoomCode
      },
      (ack: ActionAck<GameState>) => {
        if (!ack.ok || !ack.data) {
          setErrorMessage(ack.error?.message || 'Could not trigger roll right now.');
          return;
        }
        setGameState(ack.data);
        flashStatus(`Triggered roll: ${ack.data.lastDiceRoll?.value ?? ''}`);
      }
    );
  };

  const handleUnpair = () => {
    setPairedRoomCode(null);
    setGameState(null);
    setErrorMessage(null);
  };

  const activeMode: DiceMode = gameState?.customModeDisclosure.mode ?? 'RANDOM';
  const queuedValue: DiceValue | null =
    gameState?.remoteStatus.queuedCustomValue ?? null;
  const currentTurnPlayer = gameState?.players.find(
    (p) => p.id === gameState.currentTurnPlayerId
  );

  return (
    <div className="remote-shell">
      {/* Header with Connection Status */}
      <header className="remote-header">
        <div className="remote-title-row">
          <div className="remote-badge-icon">🎛️</div>
          <div>
            <h1>DICE DUO SMART REMOTE</h1>
            <p className="remote-subtitle">
              Authenticated Companion Controller &amp; Test Harness
            </p>
          </div>
        </div>

        <div className="conn-status-bar" role="status" aria-live="polite">
          <span
            className={`status-led ${
              connectionState === 'CONNECTED'
                ? 'led-green'
                : connectionState === 'CONNECTING'
                ? 'led-amber'
                : 'led-red'
            }`}
          />
          <span className="status-label">
            {connectionState === 'CONNECTED'
              ? pairedRoomCode
                ? `Connected • Paired to ${pairedRoomCode}`
                : 'Connected • Ready to Pair'
              : connectionState === 'CONNECTING'
              ? 'Connecting to Server...'
              : 'Disconnected from Server'}
          </span>
          {sessionId && <span className="session-tag">ID: {sessionId.slice(0, 10)}</span>}
        </div>
      </header>

      {/* Error & Status Alerts */}
      {errorMessage && (
        <div className="remote-error-box" role="alert">
          <div className="error-content">
            <strong>Action Rejected:</strong> {errorMessage}
          </div>
          <button
            type="button"
            className="btn-dismiss"
            onClick={() => setErrorMessage(null)}
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}

      {statusMessage && (
        <div className="remote-toast" role="status">
          ✓ {statusMessage}
        </div>
      )}

      {/* Unpaired View: Room Code + PIN Form */}
      {!pairedRoomCode || !gameState ? (
        <main className="remote-card">
          <h2>Pair with Ludo Game Room</h2>
          <p className="card-helper">
            Enter the 6-character Room Code and 4-digit Pairing PIN shown on the Ludo Android app waiting room.
          </p>

          <form onSubmit={handlePairRoom} className="pair-form">
            <div className="field-block">
              <label htmlFor="controller-label">Controller Name</label>
              <input
                id="controller-label"
                type="text"
                className="remote-input"
                maxLength={32}
                value={controllerLabel}
                onChange={(e) => setControllerLabel(e.target.value)}
              />
            </div>

            <div className="pair-inputs-grid">
              <div className="field-block">
                <label htmlFor="room-code">Room Code (6 chars)</label>
                <input
                  id="room-code"
                  type="text"
                  className="remote-input mono-code"
                  placeholder="AB12CD"
                  maxLength={6}
                  value={roomCodeInput}
                  onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
                />
              </div>

              <div className="field-block">
                <label htmlFor="pairing-pin">Pairing PIN (4 digits)</label>
                <input
                  id="pairing-pin"
                  type="text"
                  inputMode="numeric"
                  className="remote-input mono-code"
                  placeholder="1234"
                  maxLength={6}
                  value={pairingPinInput}
                  onChange={(e) => setPairingPinInput(e.target.value)}
                />
              </div>
            </div>

            <button
              type="submit"
              className="btn-remote-primary"
              disabled={connectionState !== 'CONNECTED'}
            >
              Pair Smart Remote
            </button>
          </form>
        </main>
      ) : (
        /* Paired View: Full Dice Mode & 1-6 Selection Console */
        <main className="remote-console">
          {/* Live Match Telemetry Card */}
          <section className="remote-card telemetry-card">
            <div className="telemetry-top">
              <div>
                <span className="telemetry-label">PAIRED ROOM</span>
                <div className="telemetry-room-code">{pairedRoomCode}</div>
              </div>
              <button
                type="button"
                className="btn-remote-ghost"
                onClick={handleUnpair}
              >
                Unpair
              </button>
            </div>

            <div className="telemetry-grid">
              <div className="telemetry-item">
                <span className="telemetry-label">MATCH PHASE</span>
                <strong>{gameState.phase.replace(/_/g, ' ')}</strong>
              </div>

              <div className="telemetry-item">
                <span className="telemetry-label">ACTIVE TURN</span>
                <div className="turn-indicator-inline">
                  {currentTurnPlayer && (
                    <span
                      className="color-dot"
                      style={{
                        backgroundColor: COLOR_META[currentTurnPlayer.color].primaryHex
                      }}
                    />
                  )}
                  <strong>{currentTurnPlayer?.name ?? 'Waiting'}</strong>
                </div>
              </div>

              <div className="telemetry-item">
                <span className="telemetry-label">LAST ROLL</span>
                <strong>
                  {gameState.lastDiceRoll
                    ? `${gameState.lastDiceRoll.value} (${gameState.lastDiceRoll.mode})`
                    : 'None'}
                </strong>
              </div>
            </div>
          </section>

          {/* Dice Mode Selector Card */}
          <section className="remote-card">
            <div className="section-head">
              <h2>1. Select Dice Mode</h2>
              <span
                className={`mode-badge ${
                  activeMode === 'CUSTOM_TESTING' ? 'badge-custom' : 'badge-random'
                }`}
              >
                {activeMode === 'CUSTOM_TESTING' ? 'CUSTOM TESTING' : 'RANDOM (CSPRNG)'}
              </span>
            </div>

            <div className="mode-toggle-grid">
              <button
                type="button"
                className={`mode-option-btn ${
                  activeMode === 'RANDOM' ? 'selected-random' : ''
                }`}
                onClick={() => handleSwitchMode('RANDOM')}
              >
                <span className="mode-btn-title">🎲 Random Mode</span>
                <span className="mode-btn-desc">
                  Server generates cryptographically secure 1–6 result.
                </span>
              </button>

              <button
                type="button"
                className={`mode-option-btn ${
                  activeMode === 'CUSTOM_TESTING' ? 'selected-custom' : ''
                }`}
                onClick={() => handleSwitchMode('CUSTOM_TESTING')}
              >
                <span className="mode-btn-title">🛠️ Custom Testing Mode</span>
                <span className="mode-btn-desc">
                  Select next 1–6 result. Explicitly disclosed to all players.
                </span>
              </button>
            </div>

            {/* Player Consent Status Breakdown */}
            <div className="consent-matrix">
              <div className="consent-matrix-header">
                <span>Player Consent Status</span>
                <span>
                  {gameState.customModeDisclosure.allPlayersConsented
                    ? '✓ All Players Agreed'
                    : '⚠️ Waiting for Consent'}
                </span>
              </div>
              <div className="consent-chips">
                {gameState.players.map((p) => {
                  const agreed = Boolean(
                    gameState.customModeDisclosure.playerConsents[p.id]
                  );
                  return (
                    <span
                      key={p.id}
                      className={`consent-chip ${agreed ? 'chip-agreed' : 'chip-pending'}`}
                    >
                      {p.name}: {agreed ? '✓ Agreed' : '✗ Not Consented'}
                    </span>
                  );
                })}
              </div>
            </div>
          </section>

          {/* 1-6 Dice Value Keypad */}
          <section className="remote-card">
            <div className="section-head">
              <h2>2. Select Dice Value (1–6)</h2>
              <span className="selected-readout">
                Selected:{' '}
                <strong>{queuedValue !== null ? queuedValue : 'None (Random)'}</strong>
              </span>
            </div>

            {activeMode !== 'CUSTOM_TESTING' && (
              <p className="locked-hint">
                Switch to <strong>Custom Testing Mode</strong> above to unlock manual 1–6 dice selection.
              </p>
            )}

            <div className="dice-keypad-grid" role="group" aria-label="Dice Values 1 to 6">
              {DICE_VALUES.map((val) => {
                const isSelected = queuedValue === val;
                const pips = PIP_COORDS[val];

                return (
                  <button
                    key={val}
                    type="button"
                    disabled={activeMode !== 'CUSTOM_TESTING'}
                    className={`keypad-dice-btn ${isSelected ? 'dice-btn-selected' : ''}`}
                    onClick={() => handleSelectDiceValue(val)}
                    aria-pressed={isSelected}
                    aria-label={`Select dice value ${val}`}
                  >
                    <svg viewBox="0 0 100 100" className="keypad-dice-svg">
                      <rect
                        x="8"
                        y="8"
                        width="84"
                        height="84"
                        rx="18"
                        fill={isSelected ? '#F59E0B' : '#1E293B'}
                        stroke={isSelected ? '#FEF3C7' : '#475569'}
                        strokeWidth="5"
                      />
                      {pips.map(([cx, cy], idx) => (
                        <circle
                          key={idx}
                          cx={cx}
                          cy={cy}
                          r="8.5"
                          fill={isSelected ? '#090D16' : '#F8FAFC'}
                        />
                      ))}
                    </svg>
                    <span className="keypad-num-label">Roll {val}</span>
                  </button>
                );
              })}
            </div>

            <div className="remote-actions-row">
              <button
                type="button"
                className="btn-remote-secondary"
                disabled={queuedValue === null}
                onClick={handleResetSelection}
              >
                Reset Selection
              </button>

              <button
                type="button"
                className="btn-remote-primary"
                disabled={gameState.phase !== 'WAITING_FOR_ROLL'}
                onClick={handleTriggerRemoteRoll}
              >
                Trigger Roll on Board
              </button>
            </div>
          </section>
        </main>
      )}
    </div>
  );
};
