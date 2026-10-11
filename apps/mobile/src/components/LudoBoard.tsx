import React from 'react';
import {
  COLOR_META,
  COLOR_START_TRACK_INDEX,
  GameState,
  LegalMove,
  PLAYER_COLORS,
  PlayerColor,
  SAFE_TRACK_INDICES,
  TokenState
} from '@dice-duo/shared';
import {
  getTokenCoordinates,
  HOME_PATH_COORDS,
  MAIN_TRACK_COORDS,
  YARD_SLOT_COORDS
} from '@dice-duo/game-engine';

interface LudoBoardProps {
  state: GameState;
  canMoveNow: boolean;
  onSelectToken: (tokenId: string) => void;
}

/**
 * Original 15x15 SVG Ludo Board with:
 * - 4 Colored 6x6 Corner Yards (RED top-left, GREEN top-right, YELLOW bottom-right, BLUE bottom-left)
 * - 52-square outer track with start arrows and 8 star-marked safe squares
 * - 4 Colored Home Columns leading to the central 4-triangle Victory Crown
 * - Animated tokens with automatic sub-cell stacking and pulsing legal-move rings
 */
export const LudoBoard: React.FC<LudoBoardProps> = ({
  state,
  canMoveNow,
  onSelectToken
}) => {
  const legalMoveMap = new Map<string, LegalMove>();
  if (canMoveNow) {
    for (const m of state.legalMoves) {
      legalMoveMap.set(m.tokenId, m);
    }
  }

  // Group tokens by their exact board coordinate key so stacked tokens are offset neatly
  const tokensList = Object.values(state.tokens);
  const coordGroups = new Map<string, TokenState[]>();
  for (const token of tokensList) {
    const coord = getTokenCoordinates(token);
    const key = `${coord.row.toFixed(1)},${coord.col.toFixed(1)}`;
    const group = coordGroups.get(key) ?? [];
    group.push(token);
    coordGroups.set(key, group);
  }

  const stackOffsets: Array<{ dx: number; dy: number }> = [
    { dx: -0.18, dy: -0.18 },
    { dx: 0.18, dy: -0.18 },
    { dx: -0.18, dy: 0.18 },
    { dx: 0.18, dy: 0.18 }
  ];

  const renderYard = (color: PlayerColor, startRow: number, startCol: number) => {
    const meta = COLOR_META[color];
    const isCurrentTurn = state.currentTurnColor === color && state.phase !== 'GAME_OVER';
    const slots = YARD_SLOT_COORDS[color];

    return (
      <g key={`yard-${color}`}>
        {/* Outer 6x6 Yard Box */}
        <rect
          x={startCol}
          y={startRow}
          width={6}
          height={6}
          rx={0.35}
          fill={meta.softBgHex}
          stroke={isCurrentTurn ? meta.accentHex : meta.primaryHex}
          strokeWidth={isCurrentTurn ? 0.16 : 0.08}
        />
        {/* Inner Yard Dock */}
        <rect
          x={startCol + 0.65}
          y={startRow + 0.65}
          width={4.7}
          height={4.7}
          rx={0.45}
          fill="#0B1120"
          stroke={meta.primaryHex}
          strokeWidth={0.07}
        />
        {/* 4 Token Dock Circles */}
        {slots.map((slot, idx) => (
          <circle
            key={`dock-${color}-${idx}`}
            cx={slot.col + 0.5}
            cy={slot.row + 0.5}
            r={0.56}
            fill={meta.softBgHex}
            stroke={meta.primaryHex}
            strokeWidth={0.08}
          />
        ))}
      </g>
    );
  };

  return (
    <div className="board-shell" role="region" aria-label="Ludo Game Board">
      <svg
        viewBox="0 0 15 15"
        className="ludo-board-svg"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <radialGradient id="boardBgGrad" cx="50%" cy="50%" r="70%">
            <stop offset="0%" stopColor="#1E293B" />
            <stop offset="100%" stopColor="#0F172A" />
          </radialGradient>
          <filter id="tokenShadow" x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="0.06" stdDeviation="0.06" floodColor="#000000" floodOpacity="0.7" />
          </filter>
        </defs>

        {/* Base 15x15 Board Surface */}
        <rect x={0} y={0} width={15} height={15} rx={0.4} fill="url(#boardBgGrad)" />

        {/* 52 Main Track Squares */}
        {MAIN_TRACK_COORDS.map((coord, trackIndex) => {
          let cellFill = '#1E293B';
          let startColor: PlayerColor | null = null;

          for (const c of PLAYER_COLORS) {
            if (COLOR_START_TRACK_INDEX[c] === trackIndex) {
              startColor = c;
              cellFill = COLOR_META[c].primaryHex;
            }
          }

          const isSafe = SAFE_TRACK_INDICES.includes(trackIndex);

          return (
            <g key={`track-${trackIndex}`}>
              <rect
                x={coord.col}
                y={coord.row}
                width={1}
                height={1}
                fill={cellFill}
                stroke="#334155"
                strokeWidth={0.04}
              />
              {isSafe && (
                <text
                  x={coord.col + 0.5}
                  y={coord.row + 0.68}
                  textAnchor="middle"
                  fontSize={0.55}
                  fill={startColor ? '#FFFFFF' : '#FBBF24'}
                  style={{ userSelect: 'none', pointerEvents: 'none' }}
                >
                  ★
                </text>
              )}
            </g>
          );
        })}

        {/* 4 Colored Home Stretch Columns (steps 51..55) */}
        {PLAYER_COLORS.map((color) => {
          const meta = COLOR_META[color];
          return HOME_PATH_COORDS[color].slice(0, 5).map((coord, idx) => (
            <g key={`home-path-${color}-${idx}`}>
              <rect
                x={coord.col}
                y={coord.row}
                width={1}
                height={1}
                fill={meta.primaryHex}
                fillOpacity={0.82}
                stroke="#0F172A"
                strokeWidth={0.045}
              />
              <circle
                cx={coord.col + 0.5}
                cy={coord.row + 0.5}
                r={0.12}
                fill="#FFFFFF"
                fillOpacity={0.35}
              />
            </g>
          ));
        })}

        {/* 4 Corner Yards */}
        {renderYard('RED', 0, 0)}
        {renderYard('GREEN', 0, 9)}
        {renderYard('YELLOW', 9, 9)}
        {renderYard('BLUE', 9, 0)}

        {/* Center 3x3 Home Goal Triangles (rows 6..9, cols 6..9) */}
        <g>
          {/* RED Left Triangle */}
          <polygon
            points="6,6 7.5,7.5 6,9"
            fill={COLOR_META.RED.primaryHex}
            stroke="#0F172A"
            strokeWidth={0.05}
          />
          {/* GREEN Top Triangle */}
          <polygon
            points="6,6 9,6 7.5,7.5"
            fill={COLOR_META.GREEN.primaryHex}
            stroke="#0F172A"
            strokeWidth={0.05}
          />
          {/* YELLOW Right Triangle */}
          <polygon
            points="9,6 9,9 7.5,7.5"
            fill={COLOR_META.YELLOW.primaryHex}
            stroke="#0F172A"
            strokeWidth={0.05}
          />
          {/* BLUE Bottom Triangle */}
          <polygon
            points="6,9 9,9 7.5,7.5"
            fill={COLOR_META.BLUE.primaryHex}
            stroke="#0F172A"
            strokeWidth={0.05}
          />
          {/* Center Crown Emblem */}
          <circle
            cx={7.5}
            cy={7.5}
            r={0.44}
            fill="#0F172A"
            stroke="#FBBF24"
            strokeWidth={0.06}
          />
          <text
            x={7.5}
            y={7.68}
            textAnchor="middle"
            fontSize={0.5}
            fill="#FBBF24"
            style={{ userSelect: 'none', pointerEvents: 'none' }}
          >
            ♛
          </text>
        </g>

        {/* Highlight Target Squares for Legal Moves */}
        {canMoveNow &&
          state.legalMoves.map((move) => {
            const sampleCoord = getTokenCoordinates({
              color: state.currentTurnColor,
              tokenIndex: move.tokenIndex,
              stepsFromStart: move.toSteps
            });
            return (
              <circle
                key={`target-${move.tokenId}`}
                cx={sampleCoord.col + 0.5}
                cy={sampleCoord.row + 0.5}
                r={0.34}
                fill="none"
                stroke="#FDE047"
                strokeWidth={0.06}
                strokeDasharray="0.12 0.08"
                opacity={0.85}
              />
            );
          })}

        {/* Render All 16 Player Tokens */}
        {tokensList.map((token) => {
          const baseCoord = getTokenCoordinates(token);
          const groupKey = `${baseCoord.row.toFixed(1)},${baseCoord.col.toFixed(1)}`;
          const siblings = coordGroups.get(groupKey) ?? [token];
          const indexInStack = siblings.findIndex((t) => t.id === token.id);
          const isStacked = siblings.length > 1 && token.zone !== 'YARD';
          const offset = isStacked
            ? stackOffsets[indexInStack % stackOffsets.length]
            : { dx: 0, dy: 0 };

          const cx = baseCoord.col + 0.5 + offset.dx;
          const cy = baseCoord.row + 0.5 + offset.dy;
          const radius = isStacked ? 0.27 : 0.34;
          const isMovable = legalMoveMap.has(token.id);
          const meta = COLOR_META[token.color];

          return (
            <g
              key={token.id}
              className={`board-token ${isMovable ? 'board-token-movable' : ''}`}
              onClick={() => {
                if (isMovable) {
                  onSelectToken(token.id);
                }
              }}
              style={{
                cursor: isMovable ? 'pointer' : 'default',
                transition: 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1)'
              }}
            >
              {/* Pulsing Halo if Movable */}
              {isMovable && (
                <circle
                  cx={cx}
                  cy={cy}
                  r={radius + 0.14}
                  fill="none"
                  stroke="#FDE047"
                  strokeWidth={0.07}
                  className="token-pulse-ring"
                />
              )}

              {/* Token Pawn Body */}
              <circle
                cx={cx}
                cy={cy}
                r={radius}
                fill={meta.primaryHex}
                stroke="#FFFFFF"
                strokeWidth={isMovable ? 0.08 : 0.05}
                filter="url(#tokenShadow)"
              />

              {/* Inner Specular Ring */}
              <circle
                cx={cx}
                cy={cy}
                r={radius * 0.58}
                fill={meta.accentHex}
                fillOpacity={0.9}
              />

              {/* Token Number Label (1..4) */}
              <text
                x={cx}
                y={cy + 0.09}
                textAnchor="middle"
                fontSize={isStacked ? 0.22 : 0.27}
                fontWeight="bold"
                fill="#0F172A"
                style={{ userSelect: 'none', pointerEvents: 'none' }}
              >
                {token.tokenIndex + 1}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Accessible Touch/Keyboard Action Bar for Legal Moves */}
      {canMoveNow && state.legalMoves.length > 0 && (
        <div className="legal-moves-strip" role="group" aria-label="Available Legal Token Moves">
          <span className="legal-moves-label">Select token to move:</span>
          <div className="legal-moves-buttons">
            {state.legalMoves.map((move) => (
              <button
                key={move.tokenId}
                type="button"
                className="btn-legal-move"
                onClick={() => onSelectToken(move.tokenId)}
              >
                Pawn #{move.tokenIndex + 1}
                {move.fromZone === 'YARD'
                  ? ' (Exit Yard)'
                  : move.willFinish
                  ? ' (Reach Home!)'
                  : move.willCaptureTokenIds.length > 0
                  ? ' (Capture!)'
                  : ` (+${state.lastDiceRoll?.value ?? ''})`}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
