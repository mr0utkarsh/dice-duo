import {
  COLOR_START_TRACK_INDEX,
  MAIN_TRACK_LENGTH,
  MAX_STEPS_FROM_START,
  PlayerColor,
  SAFE_TRACK_INDICES,
  TokenState,
  TokenZone
} from '@dice-duo/shared';

export interface GridCoord {
  row: number; // 0..14
  col: number; // 0..14
}

/**
 * Standard 15x15 Ludo board 52-cell clockwise outer track coordinates.
 * Index 0 is RED's starting square at (row 6, col 1).
 * Index 13 is GREEN's starting square at (row 1, col 8).
 * Index 26 is YELLOW's starting square at (row 8, col 13).
 * Index 39 is BLUE's starting square at (row 13, col 6).
 */
export const MAIN_TRACK_COORDS: readonly GridCoord[] = [
  // Left arm top row moving right (0..4) -> RED starts at index 0 (6,1)
  { row: 6, col: 1 },
  { row: 6, col: 2 },
  { row: 6, col: 3 },
  { row: 6, col: 4 },
  { row: 6, col: 5 },
  // Top arm left col moving up (5..10)
  { row: 5, col: 6 },
  { row: 4, col: 6 },
  { row: 3, col: 6 },
  { row: 2, col: 6 }, // Index 8: Star Safe Square
  { row: 1, col: 6 },
  { row: 0, col: 6 },
  // Top turn (11..12)
  { row: 0, col: 7 },
  { row: 0, col: 8 },
  // Top arm right col moving down (13..18) -> GREEN starts at index 13 (1,8)
  { row: 1, col: 8 },
  { row: 2, col: 8 },
  { row: 3, col: 8 },
  { row: 4, col: 8 },
  { row: 5, col: 8 },
  // Right arm top row moving right (18..23)
  { row: 6, col: 9 },
  { row: 6, col: 10 },
  { row: 6, col: 11 },
  { row: 6, col: 12 }, // Index 21: Star Safe Square
  { row: 6, col: 13 },
  { row: 6, col: 14 },
  // Right turn (24..25)
  { row: 7, col: 14 },
  { row: 8, col: 14 },
  // Right arm bottom row moving left (26..30) -> YELLOW starts at index 26 (8,13)
  { row: 8, col: 13 },
  { row: 8, col: 12 },
  { row: 8, col: 11 },
  { row: 8, col: 10 },
  { row: 8, col: 9 },
  // Bottom arm right col moving down (31..36)
  { row: 9, col: 8 },
  { row: 10, col: 8 },
  { row: 11, col: 8 },
  { row: 12, col: 8 }, // Index 34: Star Safe Square
  { row: 13, col: 8 },
  { row: 14, col: 8 },
  // Bottom turn (37..38)
  { row: 14, col: 7 },
  { row: 14, col: 6 },
  // Bottom arm left col moving up (39..43) -> BLUE starts at index 39 (13,6)
  { row: 13, col: 6 },
  { row: 12, col: 6 },
  { row: 11, col: 6 },
  { row: 10, col: 6 },
  { row: 9, col: 6 },
  // Left arm bottom row moving left (44..49)
  { row: 8, col: 5 },
  { row: 8, col: 4 },
  { row: 8, col: 3 },
  { row: 8, col: 2 }, // Index 47: Star Safe Square
  { row: 8, col: 1 },
  { row: 8, col: 0 },
  // Left turn (50..51)
  { row: 7, col: 0 },
  { row: 6, col: 0 }
] as const;

/**
 * Home path coordinates for steps 51..55 (5 cells) + step 56 (finished goal pocket).
 */
export const HOME_PATH_COORDS: Record<PlayerColor, readonly GridCoord[]> = {
  RED: [
    { row: 7, col: 1 }, // step 51
    { row: 7, col: 2 }, // step 52
    { row: 7, col: 3 }, // step 53
    { row: 7, col: 4 }, // step 54
    { row: 7, col: 5 }, // step 55
    { row: 7, col: 6 }  // step 56 (FINISHED)
  ],
  GREEN: [
    { row: 1, col: 7 }, // step 51
    { row: 2, col: 7 }, // step 52
    { row: 3, col: 7 }, // step 53
    { row: 4, col: 7 }, // step 54
    { row: 5, col: 7 }, // step 55
    { row: 6, col: 7 }  // step 56 (FINISHED)
  ],
  YELLOW: [
    { row: 7, col: 13 }, // step 51
    { row: 7, col: 12 }, // step 52
    { row: 7, col: 11 }, // step 53
    { row: 7, col: 10 }, // step 54
    { row: 7, col: 9 },  // step 55
    { row: 7, col: 8 }   // step 56 (FINISHED)
  ],
  BLUE: [
    { row: 13, col: 7 }, // step 51
    { row: 12, col: 7 }, // step 52
    { row: 11, col: 7 }, // step 53
    { row: 10, col: 7 }, // step 54
    { row: 9, col: 7 },  // step 55
    { row: 8, col: 7 }   // step 56 (FINISHED)
  ]
};

/**
 * Yard token slot coordinates inside each 6x6 corner yard.
 */
export const YARD_SLOT_COORDS: Record<PlayerColor, readonly GridCoord[]> = {
  RED: [
    { row: 1.5, col: 1.5 },
    { row: 1.5, col: 3.5 },
    { row: 3.5, col: 1.5 },
    { row: 3.5, col: 3.5 }
  ],
  GREEN: [
    { row: 1.5, col: 10.5 },
    { row: 1.5, col: 12.5 },
    { row: 3.5, col: 10.5 },
    { row: 3.5, col: 12.5 }
  ],
  YELLOW: [
    { row: 10.5, col: 10.5 },
    { row: 10.5, col: 12.5 },
    { row: 12.5, col: 10.5 },
    { row: 12.5, col: 12.5 }
  ],
  BLUE: [
    { row: 10.5, col: 1.5 },
    { row: 10.5, col: 3.5 },
    { row: 12.5, col: 1.5 },
    { row: 12.5, col: 3.5 }
  ]
};

/**
 * Determines the TokenZone for a given stepsFromStart value.
 */
export function stepsToZone(stepsFromStart: number): TokenZone {
  if (stepsFromStart < 0) return 'YARD';
  if (stepsFromStart <= 50) return 'TRACK';
  if (stepsFromStart < MAX_STEPS_FROM_START) return 'HOME_PATH';
  return 'FINISHED';
}

/**
 * Converts a player's color and relative stepsFromStart (0..50) into the global
 * 52-cell circular track index (0..51). Returns null if not on the main track.
 */
export function stepsToTrackIndex(color: PlayerColor, stepsFromStart: number): number | null {
  if (stepsFromStart < 0 || stepsFromStart > 50) {
    return null;
  }
  const offset = COLOR_START_TRACK_INDEX[color];
  return (offset + stepsFromStart) % MAIN_TRACK_LENGTH;
}

/**
 * Returns true if the given global track index (0..51) is one of the 8 safe squares.
 */
export function isSafeTrackIndex(trackIndex: number | null): boolean {
  if (trackIndex === null) return false;
  return SAFE_TRACK_INDICES.includes(trackIndex);
}

/**
 * Returns the 15x15 board grid coordinates for a token in any state.
 */
export function getTokenCoordinates(
  token: Pick<TokenState, 'color' | 'tokenIndex' | 'stepsFromStart'>
): GridCoord {
  const { color, tokenIndex, stepsFromStart } = token;
  if (stepsFromStart < 0) {
    return YARD_SLOT_COORDS[color][tokenIndex] ?? YARD_SLOT_COORDS[color][0];
  }
  if (stepsFromStart <= 50) {
    const trackIdx = stepsToTrackIndex(color, stepsFromStart)!;
    return MAIN_TRACK_COORDS[trackIdx];
  }
  const homeIdx = Math.min(stepsFromStart - 51, 5);
  return HOME_PATH_COORDS[color][homeIdx];
}
