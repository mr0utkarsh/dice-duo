import React from 'react';
import { COLOR_META, DiceMode, DiceValue, PlayerColor } from '@dice-duo/shared';

interface DiceRollerProps {
  value: DiceValue | null;
  mode: DiceMode;
  lastRollWasCustom: boolean;
  isRolling: boolean;
  canRoll: boolean;
  currentTurnName: string;
  currentTurnColor: PlayerColor;
  consecutiveSixes: number;
  forfeitedByThreeSixes: boolean;
  queuedCustomValue: DiceValue | null;
  onRoll: () => void;
}

const PIP_LAYOUTS: Record<DiceValue, Array<[number, number]>> = {
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

export const DiceRoller: React.FC<DiceRollerProps> = ({
  value,
  mode,
  lastRollWasCustom,
  isRolling,
  canRoll,
  currentTurnName,
  currentTurnColor,
  consecutiveSixes,
  forfeitedByThreeSixes,
  queuedCustomValue,
  onRoll
}) => {
  const displayValue: DiceValue = value ?? 6;
  const pips = PIP_LAYOUTS[displayValue];
  const colorMeta = COLOR_META[currentTurnColor];

  return (
    <div className="dice-dock-card">
      <div className="dice-turn-info">
        <div className="turn-badge-row">
          <span
            className="color-dot"
            style={{ backgroundColor: colorMeta.primaryHex }}
          />
          <span className="turn-player-name">{currentTurnName}&apos;s Turn</span>
          <span
            className={`mode-pill ${
              mode === 'CUSTOM_TESTING' ? 'mode-pill-custom' : 'mode-pill-random'
            }`}
          >
            {mode === 'CUSTOM_TESTING' ? 'CUSTOM TEST MODE' : 'CSPRNG RANDOM'}
          </span>
        </div>

        <div className="six-streak-row" aria-label="Consecutive sixes">
          <span className="streak-label">Six Streak:</span>
          {[1, 2, 3].map((pipIdx) => (
            <span
              key={pipIdx}
              className={`streak-pip ${
                consecutiveSixes >= pipIdx ? 'streak-pip-active' : ''
              }`}
            >
              6
            </span>
          ))}
          {forfeitedByThreeSixes && (
            <span className="forfeit-tag">3× Sixes — Turn Passed!</span>
          )}
        </div>

        {mode === 'CUSTOM_TESTING' && queuedCustomValue !== null && (
          <div className="queued-custom-hint">
            Smart Remote queued next roll: <strong>{queuedCustomValue}</strong>
          </div>
        )}
      </div>

      <div className="dice-action-cluster">
        <button
          type="button"
          className={`dice-cube-btn ${isRolling ? 'dice-rolling' : ''} ${
            canRoll ? 'dice-ready' : ''
          }`}
          disabled={!canRoll || isRolling}
          onClick={onRoll}
          aria-label={canRoll ? `Roll Dice for ${currentTurnName}` : 'Dice Display'}
          style={{
            borderColor: canRoll ? colorMeta.primaryHex : '#334155'
          }}
        >
          <svg viewBox="0 0 100 100" className="dice-svg">
            <rect
              x="6"
              y="6"
              width="88"
              height="88"
              rx="18"
              fill={lastRollWasCustom ? '#451A03' : '#F8FAFC'}
              stroke={lastRollWasCustom ? '#F59E0B' : colorMeta.primaryHex}
              strokeWidth="6"
            />
            {pips.map(([cx, cy], idx) => (
              <circle
                key={idx}
                cx={cx}
                cy={cy}
                r="8.5"
                fill={
                  lastRollWasCustom
                    ? '#FBBF24'
                    : displayValue === 6
                    ? colorMeta.primaryHex
                    : '#0F172A'
                }
              />
            ))}
          </svg>
        </button>

        <button
          type="button"
          className="btn-primary btn-roll-cta"
          disabled={!canRoll || isRolling}
          onClick={onRoll}
        >
          {isRolling ? 'Rolling...' : canRoll ? 'ROLL DICE' : 'Waiting...'}
        </button>
      </div>
    </div>
  );
};
