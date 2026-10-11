import {
  ActionAck,
  ConsentCustomModePayload,
  CreateRoomPayload,
  DiceMode,
  DiceValue,
  GameState,
  JoinRoomPayload,
  MoveTokenPayload,
  PairRemotePayload,
  RemotePairedData,
  RemoteResetDicePayload,
  RemoteSetDicePayload,
  RemoteSetModePayload,
  RemoteTriggerRollPayload,
  RollDicePayload,
  RoomJoinedData,
  StartMatchPayload
} from '@dice-duo/shared';
import {
  addPlayerToGame,
  applyDiceRoll,
  applyTokenMove,
  chooseBestLegalMove,
  createInitialGameState,
  setDiceMode,
  setPlayerCustomModeConsent,
  startMatch
} from '@dice-duo/game-engine';
import {
  generatePairingPin,
  generateRoomCode,
  generateSecureRandomDice,
  SessionPayload
} from './security.js';
import { PersistenceRepository } from './supabaseRepo.js';

export interface ManagedRoom {
  roomCode: string;
  pairingPin: string;
  state: GameState;
  pairedRemoteSessionIds: Set<string>;
}

/**
 * Authoritative server-side room and game state manager.
 */
export class RoomManager {
  private readonly rooms = new Map<string, ManagedRoom>();

  constructor(private readonly persistence: PersistenceRepository) {}

  public getRoom(roomCode: string): ManagedRoom | undefined {
    return this.rooms.get(roomCode.toUpperCase());
  }

  public listPublicWaitingRooms(): Array<{
    roomCode: string;
    playerCount: number;
    maxPlayers: number;
    hostName: string;
    isPublicMatchmaking: boolean;
  }> {
    const list: Array<{
      roomCode: string;
      playerCount: number;
      maxPlayers: number;
      hostName: string;
      isPublicMatchmaking: boolean;
    }> = [];

    for (const room of this.rooms.values()) {
      if (
        room.state.phase === 'WAITING_FOR_PLAYERS' &&
        room.state.players.length < room.state.maxPlayers
      ) {
        const host = room.state.players.find((p) => p.isHost) ?? room.state.players[0];
        list.push({
          roomCode: room.roomCode,
          playerCount: room.state.players.length,
          maxPlayers: room.state.maxPlayers,
          hostName: host?.name ?? 'Host',
          isPublicMatchmaking: room.state.isPublicMatchmaking
        });
      }
    }
    return list;
  }

  public createRoom(
    session: SessionPayload,
    payload: CreateRoomPayload
  ): ActionAck<RoomJoinedData> {
    let roomCode = generateRoomCode();
    while (this.rooms.has(roomCode)) {
      roomCode = generateRoomCode();
    }
    const pairingPin = generatePairingPin();

    // Public matchmaking rooms disable custom testing mode by default unless all players explicitly consent later
    const allowCustom = payload.isPublicMatchmaking
      ? false
      : payload.allowCustomTestingMode;

    const initial = createInitialGameState({
      roomCode,
      maxPlayers: payload.maxPlayers,
      isPublicMatchmaking: payload.isPublicMatchmaking,
      allowCustomTestingMode: allowCustom
    });

    const added = addPlayerToGame(initial, {
      id: session.sub,
      name: payload.playerName,
      preferredColor: payload.preferredColor,
      isHost: true,
      consentToCustomTestingMode: allowCustom
    });

    if (!added.ok) {
      return { ok: false, error: added.error };
    }

    const managed: ManagedRoom = {
      roomCode,
      pairingPin,
      state: added.state,
      pairedRemoteSessionIds: new Set()
    };
    this.rooms.set(roomCode, managed);

    return {
      ok: true,
      data: {
        roomCode,
        playerId: session.sub,
        pairingPin,
        state: managed.state
      }
    };
  }

  public joinRoom(
    session: SessionPayload,
    payload: JoinRoomPayload
  ): ActionAck<RoomJoinedData> {
    const code = payload.roomCode.toUpperCase();
    const room = this.rooms.get(code);
    if (!room) {
      return {
        ok: false,
        error: {
          code: 'ROOM_NOT_FOUND',
          message: `No active room found with code ${code}.`
        }
      };
    }

    // Check if player is already in the room (reconnect)
    const existingPlayer = room.state.players.find((p) => p.id === session.sub);
    if (existingPlayer) {
      room.state = {
        ...room.state,
        players: room.state.players.map((p) =>
          p.id === session.sub ? { ...p, isConnected: true } : p
        ),
        updatedAt: Date.now()
      };
      return {
        ok: true,
        data: {
          roomCode: room.roomCode,
          playerId: session.sub,
          pairingPin: room.pairingPin,
          state: room.state
        }
      };
    }

    const res = addPlayerToGame(room.state, {
      id: session.sub,
      name: payload.playerName,
      preferredColor: payload.preferredColor,
      consentToCustomTestingMode: payload.consentToCustomTestingMode
    });

    if (!res.ok) {
      return { ok: false, error: res.error };
    }

    room.state = res.state;
    return {
      ok: true,
      data: {
        roomCode: room.roomCode,
        playerId: session.sub,
        pairingPin: room.pairingPin,
        state: room.state
      }
    };
  }

  public markPlayerConnected(roomCode: string, playerId: string, isConnected: boolean): GameState | null {
    const room = this.rooms.get(roomCode.toUpperCase());
    if (!room) return null;
    const exists = room.state.players.some((p) => p.id === playerId);
    if (!exists) return null;

    room.state = {
      ...room.state,
      players: room.state.players.map((p) =>
        p.id === playerId ? { ...p, isConnected } : p
      ),
      updatedAt: Date.now()
    };
    return room.state;
  }

  public startRoomMatch(
    session: SessionPayload,
    payload: StartMatchPayload
  ): ActionAck<GameState> {
    const room = this.rooms.get(payload.roomCode.toUpperCase());
    if (!room) {
      return {
        ok: false,
        error: { code: 'ROOM_NOT_FOUND', message: 'Room not found.' }
      };
    }

    const player = room.state.players.find((p) => p.id === session.sub);
    if (!player || !player.isHost) {
      return {
        ok: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Only the room host can start the match.'
        }
      };
    }

    // Optionally fill remaining seats with AI bots so solo/2P testing works immediately
    if (payload.fillWithBots && room.state.players.length < room.state.maxPlayers) {
      const botNames = ['Nova Bot', 'Apex Bot', 'Vortex Bot'];
      let botIdx = 0;
      while (room.state.players.length < room.state.maxPlayers) {
        const botAdd = addPlayerToGame(room.state, {
          id: `bot-${room.roomCode}-${botIdx + 1}`,
          name: botNames[botIdx % botNames.length],
          isBot: true,
          consentToCustomTestingMode: true
        });
        if (!botAdd.ok) break;
        room.state = botAdd.state;
        botIdx++;
      }
    }

    const started = startMatch(room.state);
    if (!started.ok) {
      return { ok: false, error: started.error };
    }

    room.state = started.state;
    return { ok: true, data: room.state };
  }

  public setCustomModeConsent(
    session: SessionPayload,
    payload: ConsentCustomModePayload
  ): ActionAck<GameState> {
    const room = this.rooms.get(payload.roomCode.toUpperCase());
    if (!room) {
      return {
        ok: false,
        error: { code: 'ROOM_NOT_FOUND', message: 'Room not found.' }
      };
    }

    const updated = setPlayerCustomModeConsent(room.state, session.sub, payload.consent);
    if (!updated.ok) {
      return { ok: false, error: updated.error };
    }

    room.state = updated.state;
    return { ok: true, data: room.state };
  }

  public pairRemote(
    session: SessionPayload,
    payload: PairRemotePayload
  ): ActionAck<RemotePairedData> {
    const room = this.rooms.get(payload.roomCode.toUpperCase());
    if (!room) {
      return {
        ok: false,
        error: {
          code: 'ROOM_NOT_FOUND',
          message: `Room ${payload.roomCode.toUpperCase()} does not exist.`
        }
      };
    }

    // Verify PIN if provided, or allow if the session is already a player in that room
    const isPlayerInRoom = room.state.players.some((p) => p.id === session.sub);
    if (payload.pairingPin && payload.pairingPin !== room.pairingPin && !isPlayerInRoom) {
      return {
        ok: false,
        error: {
          code: 'INVALID_PIN',
          message: 'Invalid 4-digit Smart Remote Pairing PIN for this room.'
        }
      };
    }

    room.pairedRemoteSessionIds.add(session.sub);
    room.state = {
      ...room.state,
      remoteStatus: {
        ...room.state.remoteStatus,
        isPaired: true,
        remoteCount: room.pairedRemoteSessionIds.size,
        lastUpdatedAt: Date.now(),
        controllerLabel: payload.controllerLabel
      },
      updatedAt: Date.now()
    };

    return {
      ok: true,
      data: {
        roomCode: room.roomCode,
        state: room.state
      }
    };
  }

  private isAuthorizedRemoteOrHost(room: ManagedRoom, sessionId: string): boolean {
    if (room.pairedRemoteSessionIds.has(sessionId)) return true;
    const host = room.state.players.find((p) => p.id === sessionId && p.isHost);
    return Boolean(host);
  }

  public remoteSetMode(
    session: SessionPayload,
    payload: RemoteSetModePayload
  ): ActionAck<GameState> {
    const room = this.rooms.get(payload.roomCode.toUpperCase());
    if (!room) {
      return {
        ok: false,
        error: { code: 'ROOM_NOT_FOUND', message: 'Room not found.' }
      };
    }

    if (!this.isAuthorizedRemoteOrHost(room, session.sub)) {
      return {
        ok: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Only a paired Smart Remote or the room host can change dice mode.'
        }
      };
    }

    const res = setDiceMode(room.state, payload.mode, session.name || 'Smart Remote');
    if (!res.ok) {
      return { ok: false, error: res.error };
    }

    room.state = res.state;
    return { ok: true, data: room.state };
  }

  public remoteSetDice(
    session: SessionPayload,
    payload: RemoteSetDicePayload
  ): ActionAck<GameState> {
    const room = this.rooms.get(payload.roomCode.toUpperCase());
    if (!room) {
      return {
        ok: false,
        error: { code: 'ROOM_NOT_FOUND', message: 'Room not found.' }
      };
    }

    if (!this.isAuthorizedRemoteOrHost(room, session.sub)) {
      return {
        ok: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Remote session is not paired to this room.'
        }
      };
    }

    if (
      room.state.customModeDisclosure.mode !== 'CUSTOM_TESTING' ||
      !room.state.customModeDisclosure.allPlayersConsented
    ) {
      return {
        ok: false,
        error: {
          code: 'CUSTOM_MODE_FORBIDDEN',
          message:
            'Cannot select a custom dice value while in Random mode or without unanimous player consent.'
        }
      };
    }

    const now = Date.now();
    room.state = {
      ...room.state,
      remoteStatus: {
        ...room.state.remoteStatus,
        queuedCustomValue: payload.value,
        lastUpdatedAt: now
      },
      updatedAt: now
    };

    return { ok: true, data: room.state };
  }

  public remoteResetDice(
    session: SessionPayload,
    payload: RemoteResetDicePayload
  ): ActionAck<GameState> {
    const room = this.rooms.get(payload.roomCode.toUpperCase());
    if (!room) {
      return {
        ok: false,
        error: { code: 'ROOM_NOT_FOUND', message: 'Room not found.' }
      };
    }

    if (!this.isAuthorizedRemoteOrHost(room, session.sub)) {
      return {
        ok: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Remote session is not paired to this room.'
        }
      };
    }

    const now = Date.now();
    room.state = {
      ...room.state,
      remoteStatus: {
        ...room.state.remoteStatus,
        queuedCustomValue: null,
        lastUpdatedAt: now
      },
      updatedAt: now
    };

    return { ok: true, data: room.state };
  }

  /**
   * Authoritative dice roll.
   * - In RANDOM mode (or when no custom value is queued), generates a cryptographically
   *   secure random integer 1..6 on the server.
   * - In CUSTOM_TESTING mode (when active and all players consented) and a queued
   *   value 1..6 was set by an authorized remote, uses that value and explicitly tags
   *   the roll with `mode: 'CUSTOM_TESTING'`.
   */
  public rollDice(
    session: SessionPayload,
    payload: RollDicePayload | RemoteTriggerRollPayload,
    triggeredByRemote = false
  ): ActionAck<GameState> {
    const room = this.rooms.get(payload.roomCode.toUpperCase());
    if (!room) {
      return {
        ok: false,
        error: { code: 'ROOM_NOT_FOUND', message: 'Room not found.' }
      };
    }

    let rollerPlayerId = session.sub;
    if (triggeredByRemote) {
      if (!this.isAuthorizedRemoteOrHost(room, session.sub)) {
        return {
          ok: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Unauthorized remote roll trigger.'
          }
        };
      }
      rollerPlayerId = room.state.currentTurnPlayerId;
    }

    const isCustomEligible =
      room.state.customModeDisclosure.mode === 'CUSTOM_TESTING' &&
      room.state.customModeDisclosure.allPlayersConsented &&
      room.state.remoteStatus.queuedCustomValue !== null;

    const diceValue: DiceValue = isCustomEligible
      ? room.state.remoteStatus.queuedCustomValue!
      : generateSecureRandomDice();

    const rollMode: DiceMode = isCustomEligible ? 'CUSTOM_TESTING' : 'RANDOM';

    const res = applyDiceRoll(room.state, rollerPlayerId, diceValue, rollMode, {
      triggeredByRemote
    });

    if (!res.ok) {
      return { ok: false, error: res.error };
    }

    room.state = this.advanceBotTurnsIfNeeded(res.state);
    return { ok: true, data: room.state };
  }

  public async moveToken(
    session: SessionPayload,
    payload: MoveTokenPayload
  ): Promise<ActionAck<GameState>> {
    const room = this.rooms.get(payload.roomCode.toUpperCase());
    if (!room) {
      return {
        ok: false,
        error: { code: 'ROOM_NOT_FOUND', message: 'Room not found.' }
      };
    }

    const res = applyTokenMove(room.state, session.sub, payload.tokenId);
    if (!res.ok) {
      return { ok: false, error: res.error };
    }

    room.state = this.advanceBotTurnsIfNeeded(res.state);

    if (room.state.phase === 'GAME_OVER') {
      await this.persistence.recordCompletedMatch(room.state);
    }

    return { ok: true, data: room.state };
  }

  /**
   * If the current turn belongs to an AI bot player, automatically executes
   * its roll and tactical move so human players don't wait on bots.
   */
  private advanceBotTurnsIfNeeded(initialState: GameState): GameState {
    let state = initialState;
    let safetyCounter = 0;

    while (state.phase !== 'GAME_OVER' && safetyCounter < 20) {
      const currentPlayer = state.players.find((p) => p.id === state.currentTurnPlayerId);
      if (!currentPlayer || !currentPlayer.isBot) {
        break;
      }
      safetyCounter++;

      if (state.phase === 'WAITING_FOR_ROLL') {
        const botDice = generateSecureRandomDice();
        const rollRes = applyDiceRoll(state, currentPlayer.id, botDice, 'RANDOM');
        if (!rollRes.ok) break;
        state = rollRes.state;
      }

      if (
        state.phase === 'WAITING_FOR_MOVE' &&
        state.currentTurnPlayerId === currentPlayer.id
      ) {
        const bestMove = chooseBestLegalMove(state.legalMoves);
        if (!bestMove) break;
        const moveRes = applyTokenMove(state, currentPlayer.id, bestMove.tokenId);
        if (!moveRes.ok) break;
        state = moveRes.state;
      }
    }

    return state;
  }
}
