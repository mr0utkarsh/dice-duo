import { z } from 'zod';

// ============================================================================
// Core Player & Board Constants
// ============================================================================

export const PLAYER_COLORS = ['RED', 'GREEN', 'YELLOW', 'BLUE'] as const;
export type PlayerColor = (typeof PLAYER_COLORS)[number];

export const DICE_VALUES = [1, 2, 3, 4, 5, 6] as const;
export type DiceValue = (typeof DICE_VALUES)[number];

export const DICE_MODES = ['RANDOM', 'CUSTOM_TESTING'] as const;
export type DiceMode = (typeof DICE_MODES)[number];

export const TOKEN_STATES = ['YARD', 'TRACK', 'HOME_PATH', 'FINISHED'] as const;
export type TokenZone = (typeof TOKEN_STATES)[number];

export const TURN_PHASES = [
  'WAITING_FOR_PLAYERS',
  'WAITING_FOR_ROLL',
  'WAITING_FOR_MOVE',
  'GAME_OVER'
] as const;
export type TurnPhase = (typeof TURN_PHASES)[number];

export const ROOM_CODE_LENGTH = 6;
export const TOKENS_PER_PLAYER = 4;
export const MAIN_TRACK_LENGTH = 52;
export const HOME_PATH_LENGTH = 6; // steps 51..55 are home column, step 56 is FINISHED
export const MAX_STEPS_FROM_START = 56;
export const MAX_CONSECUTIVE_SIXES = 3;

/**
 * Global track indices (0..51) where each color starts when leaving the yard.
 */
export const COLOR_START_TRACK_INDEX: Record<PlayerColor, number> = {
  RED: 0,
  GREEN: 13,
  YELLOW: 26,
  BLUE: 39
};

/**
 * The 8 safe squares on the 52-square main perimeter track:
 * - 4 color starting squares (0, 13, 26, 39)
 * - 4 star safe squares (8, 21, 34, 47)
 */
export const SAFE_TRACK_INDICES: readonly number[] = [0, 8, 13, 21, 26, 34, 39, 47] as const;

export const COLOR_META: Record<
  PlayerColor,
  {
    label: string;
    primaryHex: string;
    accentHex: string;
    softBgHex: string;
  }
> = {
  RED: {
    label: 'Crimson Red',
    primaryHex: '#EF4444',
    accentHex: '#FCA5A5',
    softBgHex: '#450A0A'
  },
  GREEN: {
    label: 'Emerald Green',
    primaryHex: '#10B981',
    accentHex: '#6EE7B7',
    softBgHex: '#064E3B'
  },
  YELLOW: {
    label: 'Solar Gold',
    primaryHex: '#F59E0B',
    accentHex: '#FDE68A',
    softBgHex: '#451A03'
  },
  BLUE: {
    label: 'Cobalt Blue',
    primaryHex: '#3B82F6',
    accentHex: '#93C5FD',
    softBgHex: '#172554'
  }
};

// ============================================================================
// Game Engine Types
// ============================================================================

export interface TokenState {
  id: string; // e.g. "RED-0"
  color: PlayerColor;
  tokenIndex: number; // 0..3
  /**
   * -1 = in YARD
   * 0..50 = on main circular TRACK (relative to color start)
   * 51..55 = on colored HOME_PATH
   * 56 = FINISHED in central home triangle
   */
  stepsFromStart: number;
  zone: TokenZone;
  /**
   * Global track index (0..51) when zone === 'TRACK', otherwise null.
   */
  trackIndex: number | null;
}

export interface PlayerState {
  id: string;
  name: string;
  color: PlayerColor;
  isConnected: boolean;
  isHost: boolean;
  isBot?: boolean;
  finishedRank: number | null; // 1 = 1st place, 2 = 2nd, etc.
  stats: {
    rollsCount: number;
    sixesCount: number;
    capturesMade: number;
    timesCaptured: number;
    customRollsUsed: number;
  };
}

export interface LegalMove {
  tokenId: string;
  tokenIndex: number;
  fromSteps: number;
  toSteps: number;
  fromZone: TokenZone;
  toZone: TokenZone;
  targetTrackIndex: number | null;
  willCaptureTokenIds: string[];
  willFinish: boolean;
  isSafeDestination: boolean;
}

export interface DiceRollRecord {
  id: string;
  playerId: string;
  playerColor: PlayerColor;
  value: DiceValue;
  mode: DiceMode;
  timestamp: number;
  triggeredByRemote: boolean;
  forfeitedByThreeSixes: boolean;
}

export interface MoveRecord {
  id: string;
  turnNumber: number;
  playerId: string;
  playerColor: PlayerColor;
  tokenId: string;
  diceValue: DiceValue;
  diceMode: DiceMode;
  fromSteps: number;
  toSteps: number;
  capturedTokenIds: string[];
  reachedHome: boolean;
  grantedBonusRoll: boolean;
  timestamp: number;
}

export interface CustomModeDisclosure {
  mode: DiceMode;
  isPublicMatchmaking: boolean;
  customModeAllowedByRoom: boolean;
  /**
   * Map of playerId -> boolean indicating whether that player explicitly agreed
   * to allow Custom Testing Mode in this match.
   */
  playerConsents: Record<string, boolean>;
  allPlayersConsented: boolean;
  activeDisclosureMessage: string | null;
  lastModeChangeBy: string | null;
  lastModeChangeAt: number | null;
}

export interface RemotePairingStatus {
  isPaired: boolean;
  remoteCount: number;
  queuedCustomValue: DiceValue | null;
  lastUpdatedAt: number | null;
  controllerLabel: string | null;
}

export interface GameState {
  roomCode: string;
  matchId: string;
  maxPlayers: 2 | 3 | 4;
  isPublicMatchmaking: boolean;
  phase: TurnPhase;
  turnNumber: number;
  currentTurnPlayerId: string;
  currentTurnColor: PlayerColor;
  consecutiveSixes: number;
  lastDiceRoll: DiceRollRecord | null;
  legalMoves: LegalMove[];
  players: PlayerState[];
  tokens: Record<string, TokenState>;
  rankings: string[]; // ordered array of playerIds who have finished
  winnerPlayerId: string | null;
  moveHistory: MoveRecord[];
  customModeDisclosure: CustomModeDisclosure;
  remoteStatus: RemotePairingStatus;
  createdAt: number;
  updatedAt: number;
}

// ============================================================================
// Socket.IO & API Validation Schemas (Zod)
// ============================================================================

export const RoomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{6}$/, 'Room code must be exactly 6 alphanumeric characters');

export const PlayerNameSchema = z
  .string()
  .trim()
  .min(2, 'Player name must be at least 2 characters')
  .max(24, 'Player name cannot exceed 24 characters');

export const DiceValueSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6)
]);

export const DiceModeSchema = z.enum(['RANDOM', 'CUSTOM_TESTING']);

export const CreateRoomPayloadSchema = z.object({
  playerName: PlayerNameSchema,
  maxPlayers: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(2),
  preferredColor: z.enum(['RED', 'GREEN', 'YELLOW', 'BLUE']).optional(),
  isPublicMatchmaking: z.boolean().default(false),
  allowCustomTestingMode: z.boolean().default(true)
});
export type CreateRoomPayload = z.infer<typeof CreateRoomPayloadSchema>;

export const JoinRoomPayloadSchema = z.object({
  roomCode: RoomCodeSchema,
  playerName: PlayerNameSchema,
  preferredColor: z.enum(['RED', 'GREEN', 'YELLOW', 'BLUE']).optional(),
  consentToCustomTestingMode: z.boolean().default(false)
});
export type JoinRoomPayload = z.infer<typeof JoinRoomPayloadSchema>;

export const ReconnectRoomPayloadSchema = z.object({
  roomCode: RoomCodeSchema,
  playerId: z.string().min(1)
});
export type ReconnectRoomPayload = z.infer<typeof ReconnectRoomPayloadSchema>;

export const StartMatchPayloadSchema = z.object({
  roomCode: RoomCodeSchema,
  fillWithBots: z.boolean().default(false)
});
export type StartMatchPayload = z.infer<typeof StartMatchPayloadSchema>;

/**
 * Notice that RollDicePayload does NOT accept any client-supplied dice value.
 * Any dice value sent by a client in roll_dice is strictly rejected or ignored.
 */
export const RollDicePayloadSchema = z
  .object({
    roomCode: RoomCodeSchema
  })
  .strict();
export type RollDicePayload = z.infer<typeof RollDicePayloadSchema>;

export const MoveTokenPayloadSchema = z
  .object({
    roomCode: RoomCodeSchema,
    tokenId: z.string().min(3).max(16)
  })
  .strict();
export type MoveTokenPayload = z.infer<typeof MoveTokenPayloadSchema>;

export const ConsentCustomModePayloadSchema = z
  .object({
    roomCode: RoomCodeSchema,
    consent: z.boolean()
  })
  .strict();
export type ConsentCustomModePayload = z.infer<typeof ConsentCustomModePayloadSchema>;

export const PairRemotePayloadSchema = z
  .object({
    roomCode: RoomCodeSchema,
    pairingPin: z
      .string()
      .trim()
      .regex(/^[0-9]{4,6}$/, 'Pairing PIN must be 4–6 digits')
      .optional(),
    controllerLabel: z.string().trim().min(1).max(32).default('Smart Remote')
  })
  .strict();
export type PairRemotePayload = z.infer<typeof PairRemotePayloadSchema>;

export const RemoteSetModePayloadSchema = z
  .object({
    roomCode: RoomCodeSchema,
    mode: DiceModeSchema
  })
  .strict();
export type RemoteSetModePayload = z.infer<typeof RemoteSetModePayloadSchema>;

export const RemoteSetDicePayloadSchema = z
  .object({
    roomCode: RoomCodeSchema,
    value: DiceValueSchema
  })
  .strict();
export type RemoteSetDicePayload = z.infer<typeof RemoteSetDicePayloadSchema>;

export const RemoteResetDicePayloadSchema = z
  .object({
    roomCode: RoomCodeSchema
  })
  .strict();
export type RemoteResetDicePayload = z.infer<typeof RemoteResetDicePayloadSchema>;

export const RemoteTriggerRollPayloadSchema = z
  .object({
    roomCode: RoomCodeSchema
  })
  .strict();
export type RemoteTriggerRollPayload = z.infer<typeof RemoteTriggerRollPayloadSchema>;

// ============================================================================
// Socket.IO Response & Event Contracts
// ============================================================================

export interface ActionAck<T = undefined> {
  ok: boolean;
  data?: T;
  error?: {
    code:
      | 'UNAUTHORIZED'
      | 'INVALID_PAYLOAD'
      | 'ROOM_NOT_FOUND'
      | 'ROOM_FULL'
      | 'NOT_YOUR_TURN'
      | 'INVALID_PHASE'
      | 'ILLEGAL_MOVE'
      | 'CUSTOM_MODE_FORBIDDEN'
      | 'CONSENT_REQUIRED'
      | 'INVALID_PIN'
      | 'RATE_LIMITED'
      | 'INTERNAL_ERROR';
    message: string;
  };
}

export interface RoomJoinedData {
  roomCode: string;
  playerId: string;
  pairingPin: string;
  state: GameState;
}

export interface RemotePairedData {
  roomCode: string;
  state: GameState;
}
