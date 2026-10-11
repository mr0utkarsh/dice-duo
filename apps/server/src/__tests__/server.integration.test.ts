import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as createClient, Socket as ClientSocket } from 'socket.io-client';
import {
  ActionAck,
  GameState,
  RemotePairedData,
  RoomJoinedData
} from '@dice-duo/shared';
import { createDiceDuoServer, DiceDuoServerInstance } from '../app.js';
import { createSessionToken } from '../security.js';

function emitAck<T>(
  socket: ClientSocket,
  event: string,
  payload: unknown
): Promise<ActionAck<T>> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (ack: ActionAck<T>) => {
      resolve(ack);
    });
  });
}

describe('@dice-duo/server Socket.IO integration tests', () => {
  let server: DiceDuoServerInstance;
  let baseUrl: string;

  beforeAll(async () => {
    server = createDiceDuoServer();
    const port = await server.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('rejects unauthenticated Socket.IO connections', async () => {
    const unauthedClient = createClient(baseUrl, {
      reconnection: false
    });

    const err = await new Promise<Error>((resolve) => {
      unauthedClient.on('connect_error', (e) => resolve(e));
    });

    expect(err.message).toContain('UNAUTHORIZED');
    unauthedClient.close();
  });

  it('creates a room, pairs a Smart Remote, enforces Custom Testing Mode disclosure, and rejects client-spoofed dice values', async () => {
    const p1Session = createSessionToken({ name: 'Alice', role: 'player' });
    const p2Session = createSessionToken({ name: 'Bob', role: 'player' });
    const remoteSession = createSessionToken({ name: 'QA Remote', role: 'remote' });

    const p1Socket = createClient(baseUrl, {
      auth: { token: p1Session.token }
    });
    const p2Socket = createClient(baseUrl, {
      auth: { token: p2Session.token }
    });
    const remoteSocket = createClient(baseUrl, {
      auth: { token: remoteSession.token }
    });

    await Promise.all([
      new Promise<void>((r) => p1Socket.once('connect', () => r())),
      new Promise<void>((r) => p2Socket.once('connect', () => r())),
      new Promise<void>((r) => remoteSocket.once('connect', () => r()))
    ]);

    // 1. Alice creates a 2-player room
    const createRes = await emitAck<RoomJoinedData>(p1Socket, 'room:create', {
      playerName: 'Alice',
      maxPlayers: 2,
      isPublicMatchmaking: false,
      allowCustomTestingMode: true
    });
    expect(createRes.ok).toBe(true);
    const roomCode = createRes.data!.roomCode;
    const pairingPin = createRes.data!.pairingPin;

    // 2. Bob joins the room WITHOUT consenting to Custom Testing Mode yet
    const joinRes = await emitAck<RoomJoinedData>(p2Socket, 'room:join', {
      roomCode,
      playerName: 'Bob',
      consentToCustomTestingMode: false
    });
    expect(joinRes.ok).toBe(true);
    expect(joinRes.data?.state.players).toHaveLength(2);

    // 3. Alice starts the match
    const startRes = await emitAck<GameState>(p1Socket, 'match:start', {
      roomCode
    });
    expect(startRes.ok).toBe(true);
    expect(startRes.data?.phase).toBe('WAITING_FOR_ROLL');

    // 4. Smart Remote fails to pair with wrong PIN, then succeeds with valid PIN
    const badPair = await emitAck<RemotePairedData>(remoteSocket, 'remote:pair', {
      roomCode,
      pairingPin: '0000',
      controllerLabel: 'Phone Remote'
    });
    if (pairingPin !== '0000') {
      expect(badPair.ok).toBe(false);
      expect(badPair.error?.code).toBe('INVALID_PIN');
    }

    const goodPair = await emitAck<RemotePairedData>(remoteSocket, 'remote:pair', {
      roomCode,
      pairingPin,
      controllerLabel: 'Phone Remote'
    });
    expect(goodPair.ok).toBe(true);
    expect(goodPair.data?.state.remoteStatus.isPaired).toBe(true);

    // 5. Remote attempts to enable CUSTOM_TESTING before Bob consents -> rejected with CONSENT_REQUIRED
    const prematureCustom = await emitAck<GameState>(remoteSocket, 'remote:set_mode', {
      roomCode,
      mode: 'CUSTOM_TESTING'
    });
    expect(prematureCustom.ok).toBe(false);
    expect(prematureCustom.error?.code).toBe('CONSENT_REQUIRED');

    // 6. Bob consents to Custom Testing Mode
    const consentRes = await emitAck<GameState>(
      p2Socket,
      'match:consent_custom_mode',
      {
        roomCode,
        consent: true
      }
    );
    expect(consentRes.ok).toBe(true);
    expect(consentRes.data?.customModeDisclosure.allPlayersConsented).toBe(true);

    // 7. Remote enables CUSTOM_TESTING -> succeeds and discloses mode to all players
    const enableCustom = await emitAck<GameState>(remoteSocket, 'remote:set_mode', {
      roomCode,
      mode: 'CUSTOM_TESTING'
    });
    expect(enableCustom.ok).toBe(true);
    expect(enableCustom.data?.customModeDisclosure.mode).toBe('CUSTOM_TESTING');
    expect(enableCustom.data?.customModeDisclosure.activeDisclosureMessage).toContain(
      'CUSTOM TESTING MODE ACTIVE'
    );

    // 8. Remote selects dice value 5, resets it, then selects 6
    const setFive = await emitAck<GameState>(remoteSocket, 'remote:set_dice', {
      roomCode,
      value: 5
    });
    expect(setFive.ok).toBe(true);
    expect(setFive.data?.remoteStatus.queuedCustomValue).toBe(5);

    const resetDice = await emitAck<GameState>(remoteSocket, 'remote:reset_dice', {
      roomCode
    });
    expect(resetDice.ok).toBe(true);
    expect(resetDice.data?.remoteStatus.queuedCustomValue).toBeNull();

    const setSix = await emitAck<GameState>(remoteSocket, 'remote:set_dice', {
      roomCode,
      value: 6
    });
    expect(setSix.ok).toBe(true);
    expect(setSix.data?.remoteStatus.queuedCustomValue).toBe(6);

    // 9. Verify client attempting to supply its own dice value on match:roll_dice is rejected
    const spoofAttempt = await emitAck<GameState>(p1Socket, 'match:roll_dice', {
      roomCode,
      value: 6
    });
    expect(spoofAttempt.ok).toBe(false);
    expect(spoofAttempt.error?.code).toBe('INVALID_PAYLOAD');

    // 10. Legitimate roll_dice uses the remote-queued 6 and records mode = 'CUSTOM_TESTING'
    const rollRes = await emitAck<GameState>(p1Socket, 'match:roll_dice', {
      roomCode
    });
    expect(rollRes.ok).toBe(true);
    expect(rollRes.data?.lastDiceRoll?.value).toBe(6);
    expect(rollRes.data?.lastDiceRoll?.mode).toBe('CUSTOM_TESTING');
    expect(rollRes.data?.phase).toBe('WAITING_FOR_MOVE');
    expect(rollRes.data?.legalMoves).toHaveLength(4);

    p1Socket.close();
    p2Socket.close();
    remoteSocket.close();
  });
});
