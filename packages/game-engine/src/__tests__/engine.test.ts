import { describe, expect, it } from 'vitest';
import {
  addPlayerToGame,
  applyDiceRoll,
  applyTokenMove,
  chooseBestLegalMove,
  createInitialGameState,
  getTokenCoordinates,
  isSafeTrackIndex,
  setDiceMode,
  setPlayerCustomModeConsent,
  startMatch,
  stepsToTrackIndex
} from '../index.js';

function createStartedTwoPlayerMatch(options?: {
  isPublicMatchmaking?: boolean;
  allowCustomTestingMode?: boolean;
  p1Consent?: boolean;
  p2Consent?: boolean;
}) {
  let state = createInitialGameState({
    roomCode: 'TEST01',
    maxPlayers: 2,
    isPublicMatchmaking: options?.isPublicMatchmaking ?? false,
    allowCustomTestingMode: options?.allowCustomTestingMode ?? true,
    now: 1000
  });

  state = addPlayerToGame(state, {
    id: 'p1',
    name: 'Alice',
    isHost: true,
    consentToCustomTestingMode: options?.p1Consent ?? true
  }).state;

  state = addPlayerToGame(state, {
    id: 'p2',
    name: 'Bob',
    consentToCustomTestingMode: options?.p2Consent ?? true
  }).state;

  state = startMatch(state, 1100).state;
  return state;
}

describe('@dice-duo/game-engine', () => {
  it('assigns opposite colors (RED & YELLOW) in a 2-player match', () => {
    const state = createStartedTwoPlayerMatch();
    expect(state.players).toHaveLength(2);
    expect(state.players[0].color).toBe('RED');
    expect(state.players[1].color).toBe('YELLOW');
    expect(state.phase).toBe('WAITING_FOR_ROLL');
    expect(state.currentTurnPlayerId).toBe('p1');
  });

  it('requires a 6 to exit the yard; non-6 with all tokens in yard passes turn', () => {
    let state = createStartedTwoPlayerMatch();

    // p1 rolls a 4 while all RED tokens are in YARD
    const res1 = applyDiceRoll(state, 'p1', 4, 'RANDOM');
    expect(res1.ok).toBe(true);
    state = res1.state;
    // Turn should automatically advance to p2 because p1 has 0 legal moves
    expect(state.currentTurnPlayerId).toBe('p2');
    expect(state.phase).toBe('WAITING_FOR_ROLL');

    // p2 rolls a 6 -> all 4 YELLOW tokens in yard can move to start square (step 0)
    const res2 = applyDiceRoll(state, 'p2', 6, 'RANDOM');
    expect(res2.ok).toBe(true);
    state = res2.state;
    expect(state.phase).toBe('WAITING_FOR_MOVE');
    expect(state.legalMoves).toHaveLength(4);
    expect(state.legalMoves[0].toSteps).toBe(0);
    expect(state.legalMoves[0].targetTrackIndex).toBe(26); // YELLOW start index

    // p2 moves YELLOW-0 out of yard -> gets bonus roll for rolling a 6
    const moveRes = applyTokenMove(state, 'p2', 'YELLOW-0');
    expect(moveRes.ok).toBe(true);
    state = moveRes.state;
    expect(state.tokens['YELLOW-0'].stepsFromStart).toBe(0);
    expect(state.tokens['YELLOW-0'].zone).toBe('TRACK');
    expect(state.currentTurnPlayerId).toBe('p2');
    expect(state.phase).toBe('WAITING_FOR_ROLL');
  });

  it('forfeits turn when rolling three consecutive sixes', () => {
    let state = createStartedTwoPlayerMatch();

    // First 6 by p1
    state = applyDiceRoll(state, 'p1', 6, 'RANDOM').state;
    state = applyTokenMove(state, 'p1', 'RED-0').state;
    expect(state.consecutiveSixes).toBe(1);
    expect(state.currentTurnPlayerId).toBe('p1');

    // Second 6 by p1
    state = applyDiceRoll(state, 'p1', 6, 'RANDOM').state;
    state = applyTokenMove(state, 'p1', 'RED-1').state;
    expect(state.consecutiveSixes).toBe(2);
    expect(state.currentTurnPlayerId).toBe('p1');

    // Third consecutive 6 by p1 -> forfeits roll and passes turn to p2
    const thirdSix = applyDiceRoll(state, 'p1', 6, 'RANDOM');
    expect(thirdSix.ok).toBe(true);
    state = thirdSix.state;
    expect(state.lastDiceRoll?.forfeitedByThreeSixes).toBe(true);
    expect(state.consecutiveSixes).toBe(0);
    expect(state.currentTurnPlayerId).toBe('p2');
    expect(state.phase).toBe('WAITING_FOR_ROLL');
  });

  it('rejects out-of-turn rolls and illegal token moves', () => {
    let state = createStartedTwoPlayerMatch();

    const wrongPlayerRoll = applyDiceRoll(state, 'p2', 5, 'RANDOM');
    expect(wrongPlayerRoll.ok).toBe(false);
    expect(wrongPlayerRoll.error?.code).toBe('NOT_YOUR_TURN');

    state = applyDiceRoll(state, 'p1', 6, 'RANDOM').state;
    const wrongPlayerMove = applyTokenMove(state, 'p2', 'RED-0');
    expect(wrongPlayerMove.ok).toBe(false);
    expect(wrongPlayerMove.error?.code).toBe('NOT_YOUR_TURN');

    // Move RED-0 out, then roll a 3 -> RED-1 in yard is NOT a legal move
    state = applyTokenMove(state, 'p1', 'RED-0').state;
    state = applyDiceRoll(state, 'p1', 3, 'RANDOM').state;
    const illegalYardMove = applyTokenMove(state, 'p1', 'RED-1');
    expect(illegalYardMove.ok).toBe(false);
    expect(illegalYardMove.error?.code).toBe('ILLEGAL_MOVE');
  });

  it('captures opponent token on non-safe square and awards bonus roll', () => {
    let state = createStartedTwoPlayerMatch();

    // Place RED-0 at step 1 (track index 1) and YELLOW-0 at track index 5 (whichfor YELLOW is step (5 - 26 + 52) % 52 = 31)
    state.tokens['RED-0'] = {
      ...state.tokens['RED-0'],
      stepsFromStart: 1,
      zone: 'TRACK',
      trackIndex: 1
    };
    state.tokens['YELLOW-0'] = {
      ...state.tokens['YELLOW-0'],
      stepsFromStart: 31,
      zone: 'TRACK',
      trackIndex: stepsToTrackIndex('YELLOW', 31) // (26 + 31) % 52 = 5
    };

    // p1 rolls a 4 -> RED-0 moves from step 1 to step 5 (track index 5, not safe)
    state = applyDiceRoll(state, 'p1', 4, 'RANDOM').state;
    const redMove = state.legalMoves.find((m) => m.tokenId === 'RED-0');
    expect(redMove?.willCaptureTokenIds).toEqual(['YELLOW-0']);

    state = applyTokenMove(state, 'p1', 'RED-0').state;
    // YELLOW-0 should be sent back to YARD
    expect(state.tokens['YELLOW-0'].stepsFromStart).toBe(-1);
    expect(state.tokens['YELLOW-0'].zone).toBe('YARD');
    expect(state.tokens['YELLOW-0'].trackIndex).toBeNull();
    // p1 should get a bonus roll for capturing
    expect(state.currentTurnPlayerId).toBe('p1');
    expect(state.phase).toBe('WAITING_FOR_ROLL');
    expect(state.players[0].stats.capturesMade).toBe(1);
    expect(state.players[1].stats.timesCaptured).toBe(1);
  });

  it('does NOT capture opponent tokens on safe squares (start squares and star squares)', () => {
    let state = createStartedTwoPlayerMatch();

    // Track index 8 is a star safe square.
    // Put RED-0 at step 4 (track index 4) and YELLOW-0 at step 34 (track index (26+34)%52 = 8)
    state.tokens['RED-0'] = {
      ...state.tokens['RED-0'],
      stepsFromStart: 4,
      zone: 'TRACK',
      trackIndex: 4
    };
    state.tokens['YELLOW-0'] = {
      ...state.tokens['YELLOW-0'],
      stepsFromStart: 34,
      zone: 'TRACK',
      trackIndex: 8
    };
    expect(isSafeTrackIndex(8)).toBe(true);

    // p1 rolls a 4 -> RED-0 lands on track index 8
    state = applyDiceRoll(state, 'p1', 4, 'RANDOM').state;
    const redMove = state.legalMoves.find((m) => m.tokenId === 'RED-0');
    expect(redMove?.isSafeDestination).toBe(true);
    expect(redMove?.willCaptureTokenIds).toEqual([]);

    state = applyTokenMove(state, 'p1', 'RED-0').state;
    // Both tokens coexist on safe square 8
    expect(state.tokens['RED-0'].trackIndex).toBe(8);
    expect(state.tokens['YELLOW-0'].trackIndex).toBe(8);
    expect(state.tokens['YELLOW-0'].zone).toBe('TRACK');
    // Turn passes to p2 because no 6 and no capture
    expect(state.currentTurnPlayerId).toBe('p2');
  });

  it('enforces exact roll to enter home (step 56) and detects match win condition', () => {
    let state = createStartedTwoPlayerMatch();

    // Set RED-0, RED-1, RED-2 already FINISHED (step 56), and RED-3 at step 54 (needs 2 to finish)
    for (const id of ['RED-0', 'RED-1', 'RED-2']) {
      state.tokens[id] = {
        ...state.tokens[id],
        stepsFromStart: 56,
        zone: 'FINISHED',
        trackIndex: null
      };
    }
    state.tokens['RED-3'] = {
      ...state.tokens['RED-3'],
      stepsFromStart: 54,
      zone: 'HOME_PATH',
      trackIndex: null
    };

    // Roll a 5 -> overshoots 56 (54 + 5 = 59 > 56), so no legal moves and turn passes to p2
    state = applyDiceRoll(state, 'p1', 5, 'RANDOM').state;
    expect(state.currentTurnPlayerId).toBe('p2');

    // Let p2 roll 2 (all in yard -> turn returns to p1)
    state = applyDiceRoll(state, 'p2', 2, 'RANDOM').state;
    expect(state.currentTurnPlayerId).toBe('p1');

    // Now p1 rolls exact 2 -> RED-3 reaches step 56 (FINISHED) and p1 wins the match!
    state = applyDiceRoll(state, 'p1', 2, 'RANDOM').state;
    expect(state.legalMoves).toHaveLength(1);
    expect(state.legalMoves[0].willFinish).toBe(true);

    state = applyTokenMove(state, 'p1', 'RED-3').state;
    expect(state.phase).toBe('GAME_OVER');
    expect(state.winnerPlayerId).toBe('p1');
    expect(state.rankings).toEqual(['p1', 'p2']);
    expect(state.players[0].finishedRank).toBe(1);
    expect(state.players[1].finishedRank).toBe(2);
  });

  it('enforces Custom Testing Mode rules: consent required, public matchmaking restriction, explicit disclosure', () => {
    // Case 1: Public matchmaking without unanimous consent rejects CUSTOM_TESTING
    const pubState = createStartedTwoPlayerMatch({
      isPublicMatchmaking: true,
      allowCustomTestingMode: false,
      p1Consent: true,
      p2Consent: false
    });

    const pubModeAttempt = setDiceMode(pubState, 'CUSTOM_TESTING', 'RemoteController');
    expect(pubModeAttempt.ok).toBe(false);
    expect(pubModeAttempt.error?.code).toBe('CUSTOM_MODE_FORBIDDEN');

    // Case 2: Private room where both players consented allows CUSTOM_TESTING and discloses it
    let privState = createStartedTwoPlayerMatch({
      isPublicMatchmaking: false,
      allowCustomTestingMode: true,
      p1Consent: true,
      p2Consent: true
    });

    const enableRes = setDiceMode(privState, 'CUSTOM_TESTING', 'TestRemote');
    expect(enableRes.ok).toBe(true);
    privState = enableRes.state;
    expect(privState.customModeDisclosure.mode).toBe('CUSTOM_TESTING');
    expect(privState.customModeDisclosure.activeDisclosureMessage).toContain(
      'CUSTOM TESTING MODE ACTIVE'
    );

    // Roll in CUSTOM_TESTING mode records mode and increments customRollsUsed
    privState = applyDiceRoll(privState, 'p1', 6, 'CUSTOM_TESTING', {
      triggeredByRemote: true
    }).state;
    expect(privState.lastDiceRoll?.mode).toBe('CUSTOM_TESTING');
    expect(privState.players[0].stats.customRollsUsed).toBe(1);

    // If p2 revokes consent, mode immediately reverts to RANDOM
    const revokeRes = setPlayerCustomModeConsent(privState, 'p2', false);
    expect(revokeRes.ok).toBe(true);
    expect(revokeRes.state.customModeDisclosure.mode).toBe('RANDOM');
    expect(revokeRes.state.customModeDisclosure.activeDisclosureMessage).toBeNull();
  });

  it('provides valid 15x15 coordinates for yard, main track, and home path tokens', () => {
    const state = createStartedTwoPlayerMatch();
    const yardCoord = getTokenCoordinates(state.tokens['RED-0']);
    expect(yardCoord).toEqual({ row: 1.5, col: 1.5 });

    const startCoord = getTokenCoordinates({
      color: 'RED',
      tokenIndex: 0,
      stepsFromStart: 0
    });
    expect(startCoord).toEqual({ row: 6, col: 1 });

    const homeCoord = getTokenCoordinates({
      color: 'RED',
      tokenIndex: 0,
      stepsFromStart: 56
    });
    expect(homeCoord).toEqual({ row: 7, col: 6 });

    // Verify chooseBestLegalMove heuristic picks capture over ordinary advance
    const best = chooseBestLegalMove([
      {
        tokenId: 'RED-0',
        tokenIndex: 0,
        fromSteps: 2,
        toSteps: 5,
        fromZone: 'TRACK',
        toZone: 'TRACK',
        targetTrackIndex: 5,
        willCaptureTokenIds: [],
        willFinish: false,
        isSafeDestination: false
      },
      {
        tokenId: 'RED-1',
        tokenIndex: 1,
        fromSteps: 10,
        toSteps: 13,
        fromZone: 'TRACK',
        toZone: 'TRACK',
        targetTrackIndex: 13,
        willCaptureTokenIds: ['YELLOW-0'],
        willFinish: false,
        isSafeDestination: false
      }
    ]);
    expect(best?.tokenId).toBe('RED-1');
  });
});
