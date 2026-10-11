import {
  DiceMode,
  DiceRollRecord,
  DiceValue,
  GameState,
  LegalMove,
  MAX_CONSECUTIVE_SIXES,
  MAX_STEPS_FROM_START,
  MoveRecord,
  PLAYER_COLORS,
  PlayerColor,
  PlayerState,
  TOKENS_PER_PLAYER,
  TokenState
} from '@dice-duo/shared';
import { isSafeTrackIndex, stepsToTrackIndex, stepsToZone } from './board.js';

export interface CreateGameOptions {
  roomCode: string;
  matchId?: string;
  maxPlayers?: 2 | 3 | 4;
  isPublicMatchmaking?: boolean;
  allowCustomTestingMode?: boolean;
  now?: number;
}

export interface AddPlayerInput {
  id: string;
  name: string;
  preferredColor?: PlayerColor;
  isHost?: boolean;
  isBot?: boolean;
  consentToCustomTestingMode?: boolean;
}

export interface ApplyRollOptions {
  triggeredByRemote?: boolean;
  now?: number;
}

export interface EngineResult<T = GameState> {
  ok: boolean;
  state: T;
  error?: {
    code:
      | 'ROOM_FULL'
      | 'INVALID_PHASE'
      | 'NOT_YOUR_TURN'
      | 'ILLEGAL_MOVE'
      | 'CUSTOM_MODE_FORBIDDEN'
      | 'CONSENT_REQUIRED';
    message: string;
  };
}

/**
 * Creates the 4 initial tokens in the YARD for a given player color.
 */
export function createTokensForColor(color: PlayerColor): Record<string, TokenState> {
  const tokens: Record<string, TokenState> = {};
  for (let i = 0; i < TOKENS_PER_PLAYER; i++) {
    const id = `${color}-${i}`;
    tokens[id] = {
      id,
      color,
      tokenIndex: i,
      stepsFromStart: -1,
      zone: 'YARD',
      trackIndex: null
    };
  }
  return tokens;
}

/**
 * Selects the optimal next available color.
 * In a 2-player game, places the 2nd player on the opposite corner (RED <-> YELLOW, GREEN <-> BLUE)
 * if no explicit preferred color was requested.
 */
export function pickAvailableColor(
  existingColors: PlayerColor[],
  maxPlayers: 2 | 3 | 4,
  preferredColor?: PlayerColor
): PlayerColor {
  if (preferredColor && !existingColors.includes(preferredColor)) {
    return preferredColor;
  }
  if (maxPlayers === 2 && existingColors.length === 1) {
    const first = existingColors[0];
    const oppositeMap: Record<PlayerColor, PlayerColor> = {
      RED: 'YELLOW',
      YELLOW: 'RED',
      GREEN: 'BLUE',
      BLUE: 'GREEN'
    };
    const opposite = oppositeMap[first];
    if (!existingColors.includes(opposite)) {
      return opposite;
    }
  }
  for (const color of PLAYER_COLORS) {
    if (!existingColors.includes(color)) {
      return color;
    }
  }
  return 'RED';
}

/**
 * Recomputes whether all non-bot players have consented to Custom Testing Mode.
 */
function evaluateAllConsented(
  players: PlayerState[],
  consents: Record<string, boolean>
): boolean {
  const humanPlayers = players.filter((p) => !p.isBot);
  if (humanPlayers.length === 0) return false;
  return humanPlayers.every((p) => consents[p.id] === true);
}

/**
 * Creates a fresh GameState for a room.
 */
export function createInitialGameState(options: CreateGameOptions): GameState {
  const now = options.now ?? Date.now();
  const isPublic = options.isPublicMatchmaking ?? false;
  const allowCustom = options.allowCustomTestingMode ?? !isPublic;

  return {
    roomCode: options.roomCode.toUpperCase(),
    matchId: options.matchId ?? `match-${options.roomCode.toLowerCase()}-${now}`,
    maxPlayers: options.maxPlayers ?? 2,
    isPublicMatchmaking: isPublic,
    phase: 'WAITING_FOR_PLAYERS',
    turnNumber: 1,
    currentTurnPlayerId: '',
    currentTurnColor: 'RED',
    consecutiveSixes: 0,
    lastDiceRoll: null,
    legalMoves: [],
    players: [],
    tokens: {},
    rankings: [],
    winnerPlayerId: null,
    moveHistory: [],
    customModeDisclosure: {
      mode: 'RANDOM',
      isPublicMatchmaking: isPublic,
      customModeAllowedByRoom: allowCustom,
      playerConsents: {},
      allPlayersConsented: false,
      activeDisclosureMessage: null,
      lastModeChangeBy: null,
      lastModeChangeAt: null
    },
    remoteStatus: {
      isPaired: false,
      remoteCount: 0,
      queuedCustomValue: null,
      lastUpdatedAt: null,
      controllerLabel: null
    },
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Adds a player to a waiting room and initializes their 4 tokens.
 */
export function addPlayerToGame(
  state: GameState,
  input: AddPlayerInput,
  now = Date.now()
): EngineResult {
  if (state.phase !== 'WAITING_FOR_PLAYERS') {
    return {
      ok: false,
      state,
      error: {
        code: 'INVALID_PHASE',
        message: 'Cannot join after the match has already started.'
      }
    };
  }
  const existing = state.players.find((p) => p.id === input.id);
  if (existing) {
    return { ok: true, state };
  }
  if (state.players.length >= state.maxPlayers) {
    return {
      ok: false,
      state,
      error: {
        code: 'ROOM_FULL',
        message: `Room ${state.roomCode} is already full (${state.maxPlayers}/${state.maxPlayers}).`
      }
    };
  }

  const takenColors = state.players.map((p) => p.color);
  const color = pickAvailableColor(takenColors, state.maxPlayers, input.preferredColor);

  const newPlayer: PlayerState = {
    id: input.id,
    name: input.name,
    color,
    isConnected: true,
    isHost: input.isHost ?? state.players.length === 0,
    isBot: input.isBot ?? false,
    finishedRank: null,
    stats: {
      rollsCount: 0,
      sixesCount: 0,
      capturesMade: 0,
      timesCaptured: 0,
      customRollsUsed: 0
    }
  };

  const nextPlayers = [...state.players, newPlayer];
  const nextTokens = {
    ...state.tokens,
    ...createTokensForColor(color)
  };

  const nextConsents: Record<string, boolean> = {
    ...state.customModeDisclosure.playerConsents,
    [newPlayer.id]: newPlayer.isBot ? true : Boolean(input.consentToCustomTestingMode)
  };
  const allConsented = evaluateAllConsented(nextPlayers, nextConsents);

  // If a new player joins without consenting while CUSTOM_TESTING was active, revert to RANDOM
  const nextMode: DiceMode =
    state.customModeDisclosure.mode === 'CUSTOM_TESTING' && !allConsented
      ? 'RANDOM'
      : state.customModeDisclosure.mode;

  const firstPlayer = nextPlayers[0];

  return {
    ok: true,
    state: {
      ...state,
      players: nextPlayers,
      tokens: nextTokens,
      currentTurnPlayerId: state.currentTurnPlayerId || firstPlayer.id,
      currentTurnColor: state.currentTurnPlayerId ? state.currentTurnColor : firstPlayer.color,
      customModeDisclosure: {
        ...state.customModeDisclosure,
        mode: nextMode,
        playerConsents: nextConsents,
        allPlayersConsented: allConsented,
        activeDisclosureMessage:
          nextMode === 'CUSTOM_TESTING'
            ? 'CUSTOM TESTING MODE ACTIVE — Authorized Smart Remote can select dice results 1–6.'
            : null
      },
      updatedAt: now
    }
  };
}

/**
 * Starts the match once at least 2 players are in the room.
 */
export function startMatch(state: GameState, now = Date.now()): EngineResult {
  if (state.phase !== 'WAITING_FOR_PLAYERS') {
    return {
      ok: false,
      state,
      error: {
        code: 'INVALID_PHASE',
        message: 'Match has already started.'
      }
    };
  }
  if (state.players.length < 2) {
    return {
      ok: false,
      state,
      error: {
        code: 'INVALID_PHASE',
        message: 'At least 2 players are required to start a Ludo match.'
      }
    };
  }

  // Order players in standard clockwise turn order: RED -> GREEN -> YELLOW -> BLUE
  const orderedPlayers = [...state.players].sort(
    (a, b) => PLAYER_COLORS.indexOf(a.color) - PLAYER_COLORS.indexOf(b.color)
  );
  const firstPlayer = orderedPlayers[0];

  return {
    ok: true,
    state: {
      ...state,
      players: orderedPlayers,
      phase: 'WAITING_FOR_ROLL',
      turnNumber: 1,
      currentTurnPlayerId: firstPlayer.id,
      currentTurnColor: firstPlayer.color,
      consecutiveSixes: 0,
      lastDiceRoll: null,
      legalMoves: [],
      updatedAt: now
    }
  };
}

/**
 * Updates a player's consent to Custom Testing Mode.
 * If any player revokes consent while Custom Testing Mode is active, the match
 * immediately reverts to RANDOM mode and clears any queued custom dice value.
 */
export function setPlayerCustomModeConsent(
  state: GameState,
  playerId: string,
  consent: boolean,
  now = Date.now()
): EngineResult {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) {
    return {
      ok: false,
      state,
      error: {
        code: 'NOT_YOUR_TURN',
        message: 'Player not found in this match.'
      }
    };
  }

  const nextConsents: Record<string, boolean> = {
    ...state.customModeDisclosure.playerConsents,
    [playerId]: consent
  };
  const allConsented = evaluateAllConsented(state.players, nextConsents);

  const shouldRevert =
    state.customModeDisclosure.mode === 'CUSTOM_TESTING' && !allConsented;
  const nextMode: DiceMode = shouldRevert ? 'RANDOM' : state.customModeDisclosure.mode;

  return {
    ok: true,
    state: {
      ...state,
      customModeDisclosure: {
        ...state.customModeDisclosure,
        mode: nextMode,
        playerConsents: nextConsents,
        allPlayersConsented: allConsented,
        activeDisclosureMessage:
          nextMode === 'CUSTOM_TESTING'
            ? 'CUSTOM TESTING MODE ACTIVE — Authorized Smart Remote can select dice results 1–6.'
            : null,
        lastModeChangeBy: shouldRevert ? player.name : state.customModeDisclosure.lastModeChangeBy,
        lastModeChangeAt: shouldRevert ? now : state.customModeDisclosure.lastModeChangeAt
      },
      remoteStatus: {
        ...state.remoteStatus,
        queuedCustomValue: shouldRevert ? null : state.remoteStatus.queuedCustomValue
      },
      updatedAt: now
    }
  };
}

/**
 * Switches between RANDOM and CUSTOM_TESTING dice modes.
 * Enforces:
 * 1. Room must allow custom testing mode (or all players must explicitly agree).
 * 2. In ordinary public matchmaking, CUSTOM_TESTING is forbidden unless every
 *    human player in the room has explicitly consented (`allPlayersConsented === true`).
 * 3. Even in private rooms, all human players in the match must consent before
 *    CUSTOM_TESTING can be activated.
 */
export function setDiceMode(
  state: GameState,
  mode: DiceMode,
  actorLabel: string,
  now = Date.now()
): EngineResult {
  if (mode === 'RANDOM') {
    return {
      ok: true,
      state: {
        ...state,
        customModeDisclosure: {
          ...state.customModeDisclosure,
          mode: 'RANDOM',
          activeDisclosureMessage: null,
          lastModeChangeBy: actorLabel,
          lastModeChangeAt: now
        },
        remoteStatus: {
          ...state.remoteStatus,
          queuedCustomValue: null
        },
        updatedAt: now
      }
    };
  }

  // Attempting to enable CUSTOM_TESTING
  if (!state.customModeDisclosure.customModeAllowedByRoom && !state.customModeDisclosure.allPlayersConsented) {
    return {
      ok: false,
      state,
      error: {
        code: 'CUSTOM_MODE_FORBIDDEN',
        message:
          'Custom Testing Mode is disabled for this room unless all players explicitly consent.'
      }
    };
  }

  if (state.isPublicMatchmaking && !state.customModeDisclosure.allPlayersConsented) {
    return {
      ok: false,
      state,
      error: {
        code: 'CUSTOM_MODE_FORBIDDEN',
        message:
          'Custom Testing Mode is disabled in public matchmaking unless all players in the match explicitly agree.'
      }
    };
  }

  if (!state.customModeDisclosure.allPlayersConsented) {
    return {
      ok: false,
      state,
      error: {
        code: 'CONSENT_REQUIRED',
        message:
          'All players in the match must agree to Custom Testing Mode before it can be activated.'
      }
    };
  }

  return {
    ok: true,
    state: {
      ...state,
      customModeDisclosure: {
        ...state.customModeDisclosure,
        mode: 'CUSTOM_TESTING',
        activeDisclosureMessage: `CUSTOM TESTING MODE ACTIVE (enabled by ${actorLabel}) — Selected dice rolls 1–6 are disclosed to all players.`,
        lastModeChangeBy: actorLabel,
        lastModeChangeAt: now
      },
      updatedAt: now
    }
  };
}

/**
 * Computes all legal token moves for a given player color and dice value (1..6).
 */
export function computeLegalMoves(
  state: GameState,
  playerColor: PlayerColor,
  diceValue: DiceValue
): LegalMove[] {
  const playerTokens = Object.values(state.tokens)
    .filter((t) => t.color === playerColor)
    .sort((a, b) => a.tokenIndex - b.tokenIndex);

  const legalMoves: LegalMove[] = [];

  for (const token of playerTokens) {
    if (token.zone === 'FINISHED' || token.stepsFromStart >= MAX_STEPS_FROM_START) {
      continue;
    }

    // Rule 1: Token in YARD requires a 6 to enter the start square (stepsFromStart = 0)
    if (token.stepsFromStart === -1) {
      if (diceValue === 6) {
        const startTrackIdx = stepsToTrackIndex(playerColor, 0)!;
        legalMoves.push({
          tokenId: token.id,
          tokenIndex: token.tokenIndex,
          fromSteps: -1,
          toSteps: 0,
          fromZone: 'YARD',
          toZone: 'TRACK',
          targetTrackIndex: startTrackIdx,
          willCaptureTokenIds: [], // Start squares are always safe squares
          willFinish: false,
          isSafeDestination: true
        });
      }
      continue;
    }

    // Rule 2: Token on TRACK or HOME_PATH advances by diceValue, must not overshoot 56
    const toSteps = token.stepsFromStart + diceValue;
    if (toSteps > MAX_STEPS_FROM_START) {
      continue;
    }

    const toZone = stepsToZone(toSteps);
    const targetTrackIndex = stepsToTrackIndex(playerColor, toSteps);
    const isSafeDestination =
      toZone === 'HOME_PATH' ||
      toZone === 'FINISHED' ||
      isSafeTrackIndex(targetTrackIndex);

    // Check captures: only on non-safe main TRACK squares
    let willCaptureTokenIds: string[] = [];
    if (toZone === 'TRACK' && targetTrackIndex !== null && !isSafeTrackIndex(targetTrackIndex)) {
      willCaptureTokenIds = Object.values(state.tokens)
        .filter(
          (other) =>
            other.color !== playerColor &&
            other.zone === 'TRACK' &&
            other.trackIndex === targetTrackIndex
        )
        .map((other) => other.id);
    }

    legalMoves.push({
      tokenId: token.id,
      tokenIndex: token.tokenIndex,
      fromSteps: token.stepsFromStart,
      toSteps,
      fromZone: token.zone,
      toZone,
      targetTrackIndex,
      willCaptureTokenIds,
      willFinish: toSteps === MAX_STEPS_FROM_START,
      isSafeDestination
    });
  }

  return legalMoves;
}

/**
 * Helper to find the next unfinished player in clockwise turn order.
 */
export function getNextActivePlayer(state: GameState, currentPlayerId: string): PlayerState {
  const activePlayers = state.players.filter((p) => p.finishedRank === null);
  if (activePlayers.length === 0) {
    return state.players[0];
  }
  const currentIdx = state.players.findIndex((p) => p.id === currentPlayerId);
  for (let offset = 1; offset <= state.players.length; offset++) {
    const candidate = state.players[(currentIdx + offset) % state.players.length];
    if (candidate.finishedRank === null) {
      return candidate;
    }
  }
  return activePlayers[0];
}

/**
 * Applies an authoritative dice roll to the game state.
 */
export function applyDiceRoll(
  state: GameState,
  playerId: string,
  diceValue: DiceValue,
  mode: DiceMode,
  options: ApplyRollOptions = {}
): EngineResult {
  const now = options.now ?? Date.now();

  if (state.phase !== 'WAITING_FOR_ROLL') {
    return {
      ok: false,
      state,
      error: {
        code: 'INVALID_PHASE',
        message: `Cannot roll dice during phase ${state.phase}.`
      }
    };
  }

  if (state.currentTurnPlayerId !== playerId) {
    return {
      ok: false,
      state,
      error: {
        code: 'NOT_YOUR_TURN',
        message: 'It is not your turn to roll the dice.'
      }
    };
  }

  if (mode === 'CUSTOM_TESTING') {
    if (
      state.customModeDisclosure.mode !== 'CUSTOM_TESTING' ||
      !state.customModeDisclosure.allPlayersConsented
    ) {
      return {
        ok: false,
        state,
        error: {
          code: 'CUSTOM_MODE_FORBIDDEN',
          message:
            'Custom Testing Mode dice roll rejected because Custom Testing Mode is not active and consented by all players.'
        }
      };
    }
  }

  const currentPlayer = state.players.find((p) => p.id === playerId)!;
  const newConsecutiveSixes = diceValue === 6 ? state.consecutiveSixes + 1 : 0;
  const forfeitedByThreeSixes = newConsecutiveSixes >= MAX_CONSECUTIVE_SIXES;

  const rollRecord: DiceRollRecord = {
    id: `roll-${state.turnNumber}-${now}`,
    playerId,
    playerColor: currentPlayer.color,
    value: diceValue,
    mode,
    timestamp: now,
    triggeredByRemote: Boolean(options.triggeredByRemote),
    forfeitedByThreeSixes
  };

  const updatedPlayers = state.players.map((p) => {
    if (p.id !== playerId) return p;
    return {
      ...p,
      stats: {
        ...p.stats,
        rollsCount: p.stats.rollsCount + 1,
        sixesCount: diceValue === 6 ? p.stats.sixesCount + 1 : p.stats.sixesCount,
        customRollsUsed:
          mode === 'CUSTOM_TESTING' ? p.stats.customRollsUsed + 1 : p.stats.customRollsUsed
      }
    };
  });

  // Rule: Rolling 3 consecutive sixes forfeits the turn immediately
  if (forfeitedByThreeSixes) {
    const nextPlayer = getNextActivePlayer(state, playerId);
    return {
      ok: true,
      state: {
        ...state,
        players: updatedPlayers,
        phase: 'WAITING_FOR_ROLL',
        turnNumber: state.turnNumber + 1,
        currentTurnPlayerId: nextPlayer.id,
        currentTurnColor: nextPlayer.color,
        consecutiveSixes: 0,
        lastDiceRoll: rollRecord,
        legalMoves: [],
        remoteStatus: {
          ...state.remoteStatus,
          queuedCustomValue: null
        },
        updatedAt: now
      }
    };
  }

  const legalMoves = computeLegalMoves(state, currentPlayer.color, diceValue);

  // If player has no legal moves, automatically pass turn to next active player
  if (legalMoves.length === 0) {
    const nextPlayer = getNextActivePlayer(state, playerId);
    return {
      ok: true,
      state: {
        ...state,
        players: updatedPlayers,
        phase: 'WAITING_FOR_ROLL',
        turnNumber: state.turnNumber + 1,
        currentTurnPlayerId: nextPlayer.id,
        currentTurnColor: nextPlayer.color,
        consecutiveSixes: 0,
        lastDiceRoll: rollRecord,
        legalMoves: [],
        remoteStatus: {
          ...state.remoteStatus,
          queuedCustomValue: null
        },
        updatedAt: now
      }
    };
  }

  return {
    ok: true,
    state: {
      ...state,
      players: updatedPlayers,
      phase: 'WAITING_FOR_MOVE',
      consecutiveSixes: newConsecutiveSixes,
      lastDiceRoll: rollRecord,
      legalMoves,
      remoteStatus: {
        ...state.remoteStatus,
        queuedCustomValue: null
      },
      updatedAt: now
    }
  };
}

/**
 * Applies a player's chosen token move after rolling the dice.
 */
export function applyTokenMove(
  state: GameState,
  playerId: string,
  tokenId: string,
  now = Date.now()
): EngineResult {
  if (state.phase !== 'WAITING_FOR_MOVE' || !state.lastDiceRoll) {
    return {
      ok: false,
      state,
      error: {
        code: 'INVALID_PHASE',
        message: 'You must roll the dice before moving a token.'
      }
    };
  }

  if (state.currentTurnPlayerId !== playerId) {
    return {
      ok: false,
      state,
      error: {
        code: 'NOT_YOUR_TURN',
        message: 'It is not your turn to move.'
      }
    };
  }

  const legalMove = state.legalMoves.find((m) => m.tokenId === tokenId);
  if (!legalMove) {
    return {
      ok: false,
      state,
      error: {
        code: 'ILLEGAL_MOVE',
        message: `Token ${tokenId} cannot legally move with a roll of ${state.lastDiceRoll.value}.`
      }
    };
  }

  const movingToken = state.tokens[tokenId];
  const nextTokens: Record<string, TokenState> = {
    ...state.tokens,
    [tokenId]: {
      ...movingToken,
      stepsFromStart: legalMove.toSteps,
      zone: legalMove.toZone,
      trackIndex: legalMove.targetTrackIndex
    }
  };

  // Send captured opponent tokens back to their YARD
  const capturedColorsCount: Record<PlayerColor, number> = {
    RED: 0,
    GREEN: 0,
    YELLOW: 0,
    BLUE: 0
  };

  for (const capturedId of legalMove.willCaptureTokenIds) {
    const victim = nextTokens[capturedId];
    if (victim) {
      capturedColorsCount[victim.color] += 1;
      nextTokens[capturedId] = {
        ...victim,
        stepsFromStart: -1,
        zone: 'YARD',
        trackIndex: null
      };
    }
  }

  // Check if all 4 tokens of the current player have now reached FINISHED
  const playerColor = movingToken.color;
  const allFourFinished = Object.values(nextTokens)
    .filter((t) => t.color === playerColor)
    .every((t) => t.zone === 'FINISHED' && t.stepsFromStart === MAX_STEPS_FROM_START);

  const nextRankings = [...state.rankings];
  if (allFourFinished && !nextRankings.includes(playerId)) {
    nextRankings.push(playerId);
  }

  const nextPlayers = state.players.map((p) => {
    const rankIndex = nextRankings.indexOf(p.id);
    const finishedRank = rankIndex >= 0 ? rankIndex + 1 : p.finishedRank;
    if (p.id === playerId) {
      return {
        ...p,
        finishedRank,
        stats: {
          ...p.stats,
          capturesMade: p.stats.capturesMade + legalMove.willCaptureTokenIds.length
        }
      };
    }
    const timesHit = capturedColorsCount[p.color] ?? 0;
    if (timesHit > 0 || finishedRank !== p.finishedRank) {
      return {
        ...p,
        finishedRank,
        stats: {
          ...p.stats,
          timesCaptured: p.stats.timesCaptured + timesHit
        }
      };
    }
    return p;
  });

  // Check if the match is over (when all but 1 player has finished, or in 2P when 1 finishes)
  const unfinishedPlayers = nextPlayers.filter((p) => p.finishedRank === null);
  const isGameOver = unfinishedPlayers.length <= 1 && nextRankings.length >= 1;

  // If game over, append remaining unfinished player to rankings
  if (isGameOver && unfinishedPlayers.length === 1) {
    const lastPlayer = unfinishedPlayers[0];
    if (!nextRankings.includes(lastPlayer.id)) {
      nextRankings.push(lastPlayer.id);
    }
  }

  const finalizedPlayers = isGameOver
    ? nextPlayers.map((p) => ({
        ...p,
        finishedRank: nextRankings.indexOf(p.id) + 1
      }))
    : nextPlayers;

  const grantedBonusRoll =
    !isGameOver &&
    !allFourFinished &&
    (state.lastDiceRoll.value === 6 ||
      legalMove.willCaptureTokenIds.length > 0 ||
      legalMove.willFinish);

  const moveRecord: MoveRecord = {
    id: `move-${state.turnNumber}-${now}`,
    turnNumber: state.turnNumber,
    playerId,
    playerColor,
    tokenId,
    diceValue: state.lastDiceRoll.value,
    diceMode: state.lastDiceRoll.mode,
    fromSteps: legalMove.fromSteps,
    toSteps: legalMove.toSteps,
    capturedTokenIds: legalMove.willCaptureTokenIds,
    reachedHome: legalMove.willFinish,
    grantedBonusRoll,
    timestamp: now
  };

  const nextHistory = [moveRecord, ...state.moveHistory].slice(0, 50);

  if (isGameOver) {
    return {
      ok: true,
      state: {
        ...state,
        phase: 'GAME_OVER',
        players: finalizedPlayers,
        tokens: nextTokens,
        legalMoves: [],
        rankings: nextRankings,
        winnerPlayerId: nextRankings[0] ?? playerId,
        moveHistory: nextHistory,
        consecutiveSixes: 0,
        updatedAt: now
      }
    };
  }

  if (grantedBonusRoll) {
    return {
      ok: true,
      state: {
        ...state,
        phase: 'WAITING_FOR_ROLL',
        players: finalizedPlayers,
        tokens: nextTokens,
        legalMoves: [],
        rankings: nextRankings,
        moveHistory: nextHistory,
        updatedAt: now
      }
    };
  }

  const tempStateForNext: GameState = {
    ...state,
    players: finalizedPlayers
  };
  const nextPlayer = getNextActivePlayer(tempStateForNext, playerId);

  return {
    ok: true,
    state: {
      ...state,
      phase: 'WAITING_FOR_ROLL',
      turnNumber: state.turnNumber + 1,
      currentTurnPlayerId: nextPlayer.id,
      currentTurnColor: nextPlayer.color,
      consecutiveSixes: 0,
      players: finalizedPlayers,
      tokens: nextTokens,
      legalMoves: [],
      rankings: nextRankings,
      moveHistory: nextHistory,
      updatedAt: now
    }
  };
}

/**
 * Smart tactical heuristic for AI / bot turns or move hints:
 * Priorities:
 * 1. Capturing an opponent token (+1000)
 * 2. Reaching FINISHED home triangle (+800)
 * 3. Exiting the YARD on a 6 (+600)
 * 4. Landing on a safe square (+300)
 * 5. Entering HOME_PATH (+250)
 * 6. Advancing the furthest-along token (+toSteps)
 */
export function chooseBestLegalMove(legalMoves: LegalMove[]): LegalMove | null {
  if (legalMoves.length === 0) return null;
  let best = legalMoves[0];
  let bestScore = -Infinity;

  for (const move of legalMoves) {
    let score = move.toSteps * 2;
    if (move.willCaptureTokenIds.length > 0) score += 1000 * move.willCaptureTokenIds.length;
    if (move.willFinish) score += 800;
    if (move.fromZone === 'YARD') score += 600;
    if (move.isSafeDestination) score += 300;
    if (move.toZone === 'HOME_PATH') score += 250;
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }

  return best;
}
