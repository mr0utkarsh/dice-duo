import http from 'node:http';
import cors from 'cors';
import express from 'express';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { z } from 'zod';
import {
  ActionAck,
  ConsentCustomModePayloadSchema,
  CreateRoomPayloadSchema,
  JoinRoomPayloadSchema,
  MoveTokenPayloadSchema,
  PairRemotePayloadSchema,
  RemoteResetDicePayloadSchema,
  RemoteSetDicePayloadSchema,
  RemoteSetModePayloadSchema,
  RemoteTriggerRollPayloadSchema,
  RollDicePayloadSchema,
  StartMatchPayloadSchema
} from '@dice-duo/shared';
import { RoomManager } from './roomManager.js';
import {
  createSessionToken,
  SessionPayload,
  SlidingWindowRateLimiter,
  verifySessionToken
} from './security.js';
import { PersistenceRepository } from './supabaseRepo.js';

export interface DiceDuoServerInstance {
  app: express.Express;
  httpServer: http.Server;
  io: SocketIOServer;
  roomManager: RoomManager;
  persistence: PersistenceRepository;
  listen: (port: number, host?: string) => Promise<number>;
  close: () => Promise<void>;
}

interface AuthedSocket extends Socket {
  data: {
    session: SessionPayload;
    joinedRoomCodes: Set<string>;
  };
}

export function createDiceDuoServer(): DiceDuoServerInstance {
  const app = express();
  const persistence = new PersistenceRepository();
  const roomManager = new RoomManager(persistence);
  const httpRateLimiter = new SlidingWindowRateLimiter(120, 60_000);
  const socketRateLimiter = new SlidingWindowRateLimiter(60, 10_000);

  app.use(
    cors({
      origin: true,
      credentials: true
    })
  );
  app.use(express.json({ limit: '64kb' }));

  // Basic HTTP Rate Limiter Middleware
  app.use((req, res, next) => {
    const key = req.ip || 'anon';
    if (!httpRateLimiter.allow(key)) {
      res.status(429).json({
        ok: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many HTTP requests. Please slow down.'
        }
      });
      return;
    }
    next();
  });

  // Health Check
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'dice-duo-server',
      supabaseConfigured: persistence.isSupabaseConfigured(),
      timestamp: new Date().toISOString()
    });
  });

  // Issue or refresh an authenticated player/remote session token
  app.post('/api/session', (req, res) => {
    const rawName = typeof req.body?.name === 'string' ? req.body.name : 'Player';
    const rawRole = req.body?.role === 'remote' ? 'remote' : 'player';
    const existingToken =
      typeof req.body?.existingToken === 'string' ? req.body.existingToken : undefined;

    const existing = verifySessionToken(existingToken);
    const issued = createSessionToken({
      sub: existing?.sub,
      name: rawName,
      role: rawRole
    });

    res.json({
      ok: true,
      token: issued.token,
      session: issued.payload
    });
  });

  // List public waiting rooms
  app.get('/api/rooms', (_req, res) => {
    res.json({
      ok: true,
      rooms: roomManager.listPublicWaitingRooms()
    });
  });

  // Inspect public room metadata by code
  app.get('/api/rooms/:roomCode', (req, res) => {
    const room = roomManager.getRoom(req.params.roomCode);
    if (!room) {
      res.status(404).json({
        ok: false,
        error: { code: 'ROOM_NOT_FOUND', message: 'Room not found.' }
      });
      return;
    }
    res.json({
      ok: true,
      room: {
        roomCode: room.roomCode,
        phase: room.state.phase,
        maxPlayers: room.state.maxPlayers,
        playerCount: room.state.players.length,
        isPublicMatchmaking: room.state.isPublicMatchmaking,
        diceMode: room.state.customModeDisclosure.mode
      }
    });
  });

  // Fetch recent completed matches
  app.get('/api/matches', async (_req, res) => {
    const matches = await persistence.getRecentMatches(20);
    res.json({
      ok: true,
      matches
    });
  });

  const httpServer = http.createServer(app);

  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: true,
      credentials: true
    }
  });

  // Socket.IO Authentication Middleware
  io.use((socket, next) => {
    const authHeader = socket.handshake.headers.authorization;
    const bearerToken =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : undefined;
    const handshakeToken =
      (socket.handshake.auth?.token as string | undefined) || bearerToken;

    let session = verifySessionToken(handshakeToken);

    // If a client connects with a displayName in auth but no pre-issued token, issue an ephemeral session
    if (!session && typeof socket.handshake.auth?.guestName === 'string') {
      session = createSessionToken({
        name: socket.handshake.auth.guestName,
        role: socket.handshake.auth?.role === 'remote' ? 'remote' : 'player'
      }).payload;
    }

    if (!session) {
      next(new Error('UNAUTHORIZED: Valid session token required'));
      return;
    }

    (socket as AuthedSocket).data = {
      session,
      joinedRoomCodes: new Set<string>()
    };
    next();
  });

  function validateAndRateLimit<T>(
    socket: AuthedSocket,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    rawPayload: unknown
  ): { ok: true; data: T } | { ok: false; ack: ActionAck<never> } {
    if (!socketRateLimiter.allow(socket.data.session.sub)) {
      return {
        ok: false,
        ack: {
          ok: false,
          error: {
            code: 'RATE_LIMITED',
            message: 'Rate limit exceeded. Please wait before sending more actions.'
          }
        }
      };
    }

    const parsed = schema.safeParse(rawPayload);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message || 'Invalid request payload.';
      return {
        ok: false,
        ack: {
          ok: false,
          error: {
            code: 'INVALID_PAYLOAD',
            message: firstIssue
          }
        }
      };
    }

    return { ok: true, data: parsed.data };
  }

  function broadcastRoomState(roomCode: string): void {
    const room = roomManager.getRoom(roomCode);
    if (!room) return;
    io.to(`room:${room.roomCode}`).emit('room:state', room.state);
  }

  io.on('connection', (rawSocket) => {
    const socket = rawSocket as AuthedSocket;
    const session = socket.data.session;

    socket.emit('session:ready', {
      sub: session.sub,
      name: session.name,
      role: session.role
    });

    // 1. Create Room
    socket.on('room:create', (rawPayload, callback?: (ack: ActionAck<unknown>) => void) => {
      const check = validateAndRateLimit(socket, CreateRoomPayloadSchema, rawPayload);
      if (!check.ok) {
        callback?.(check.ack);
        return;
      }

      const result = roomManager.createRoom(session, check.data);
      if (result.ok && result.data) {
        const code = result.data.roomCode;
        socket.join(`room:${code}`);
        socket.data.joinedRoomCodes.add(code);
        broadcastRoomState(code);
      }
      callback?.(result);
    });

    // 2. Join Room (or Reconnect)
    socket.on('room:join', (rawPayload, callback?: (ack: ActionAck<unknown>) => void) => {
      const check = validateAndRateLimit(socket, JoinRoomPayloadSchema, rawPayload);
      if (!check.ok) {
        callback?.(check.ack);
        return;
      }

      const result = roomManager.joinRoom(session, check.data);
      if (result.ok && result.data) {
        const code = result.data.roomCode;
        socket.join(`room:${code}`);
        socket.data.joinedRoomCodes.add(code);
        broadcastRoomState(code);
      }
      callback?.(result);
    });

    // 3. Start Match
    socket.on('match:start', (rawPayload, callback?: (ack: ActionAck<unknown>) => void) => {
      const check = validateAndRateLimit(socket, StartMatchPayloadSchema, rawPayload);
      if (!check.ok) {
        callback?.(check.ack);
        return;
      }

      const result = roomManager.startRoomMatch(session, check.data);
      if (result.ok && result.data) {
        broadcastRoomState(result.data.roomCode);
      }
      callback?.(result);
    });

    // 4. Player Consent to Custom Testing Mode
    socket.on(
      'match:consent_custom_mode',
      (rawPayload, callback?: (ack: ActionAck<unknown>) => void) => {
        const check = validateAndRateLimit(
          socket,
          ConsentCustomModePayloadSchema,
          rawPayload
        );
        if (!check.ok) {
          callback?.(check.ack);
          return;
        }

        const result = roomManager.setCustomModeConsent(session, check.data);
        if (result.ok && result.data) {
          broadcastRoomState(result.data.roomCode);
        }
        callback?.(result);
      }
    );

    // 5. Roll Dice (Strictly rejects any client-supplied dice value via RollDicePayloadSchema.strict())
    socket.on('match:roll_dice', (rawPayload, callback?: (ack: ActionAck<unknown>) => void) => {
      const check = validateAndRateLimit(socket, RollDicePayloadSchema, rawPayload);
      if (!check.ok) {
        callback?.(check.ack);
        return;
      }

      const result = roomManager.rollDice(session, check.data, false);
      if (result.ok && result.data) {
        broadcastRoomState(result.data.roomCode);
      }
      callback?.(result);
    });

    // 6. Move Token
    socket.on(
      'match:move_token',
      async (rawPayload, callback?: (ack: ActionAck<unknown>) => void) => {
        const check = validateAndRateLimit(socket, MoveTokenPayloadSchema, rawPayload);
        if (!check.ok) {
          callback?.(check.ack);
          return;
        }

        const result = await roomManager.moveToken(session, check.data);
        if (result.ok && result.data) {
          broadcastRoomState(result.data.roomCode);
        }
        callback?.(result);
      }
    );

    // 7. Pair Smart Remote
    socket.on('remote:pair', (rawPayload, callback?: (ack: ActionAck<unknown>) => void) => {
      const check = validateAndRateLimit(socket, PairRemotePayloadSchema, rawPayload);
      if (!check.ok) {
        callback?.(check.ack);
        return;
      }

      const result = roomManager.pairRemote(session, check.data);
      if (result.ok && result.data) {
        const code = result.data.roomCode;
        socket.join(`room:${code}`);
        socket.data.joinedRoomCodes.add(code);
        broadcastRoomState(code);
      }
      callback?.(result);
    });

    // 8. Smart Remote: Switch Dice Mode (RANDOM vs CUSTOM_TESTING)
    socket.on('remote:set_mode', (rawPayload, callback?: (ack: ActionAck<unknown>) => void) => {
      const check = validateAndRateLimit(socket, RemoteSetModePayloadSchema, rawPayload);
      if (!check.ok) {
        callback?.(check.ack);
        return;
      }

      const result = roomManager.remoteSetMode(session, check.data);
      if (result.ok && result.data) {
        broadcastRoomState(result.data.roomCode);
      }
      callback?.(result);
    });

    // 9. Smart Remote: Select Custom Dice Value (1..6)
    socket.on('remote:set_dice', (rawPayload, callback?: (ack: ActionAck<unknown>) => void) => {
      const check = validateAndRateLimit(socket, RemoteSetDicePayloadSchema, rawPayload);
      if (!check.ok) {
        callback?.(check.ack);
        return;
      }

      const result = roomManager.remoteSetDice(session, check.data);
      if (result.ok && result.data) {
        broadcastRoomState(result.data.roomCode);
      }
      callback?.(result);
    });

    // 10. Smart Remote: Reset Selected Dice Value
    socket.on(
      'remote:reset_dice',
      (rawPayload, callback?: (ack: ActionAck<unknown>) => void) => {
        const check = validateAndRateLimit(
          socket,
          RemoteResetDicePayloadSchema,
          rawPayload
        );
        if (!check.ok) {
          callback?.(check.ack);
          return;
        }

        const result = roomManager.remoteResetDice(session, check.data);
        if (result.ok && result.data) {
          broadcastRoomState(result.data.roomCode);
        }
        callback?.(result);
      }
    );

    // 11. Smart Remote: Trigger Roll for Current Turn
    socket.on(
      'remote:trigger_roll',
      (rawPayload, callback?: (ack: ActionAck<unknown>) => void) => {
        const check = validateAndRateLimit(
          socket,
          RemoteTriggerRollPayloadSchema,
          rawPayload
        );
        if (!check.ok) {
          callback?.(check.ack);
          return;
        }

        const result = roomManager.rollDice(session, check.data, true);
        if (result.ok && result.data) {
          broadcastRoomState(result.data.roomCode);
        }
        callback?.(result);
      }
    );

    // Handle disconnect
    socket.on('disconnect', () => {
      for (const code of socket.data.joinedRoomCodes) {
        const updated = roomManager.markPlayerConnected(code, session.sub, false);
        if (updated) {
          broadcastRoomState(code);
        }
      }
    });
  });

  return {
    app,
    httpServer,
    io,
    roomManager,
    persistence,
    listen: (port: number, host = '0.0.0.0') =>
      new Promise<number>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
          const addr = httpServer.address();
          const boundPort = typeof addr === 'object' && addr ? addr.port : port;
          resolve(boundPort);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        io.close(() => {
          httpServer.close(() => resolve());
        });
      })
  };
}
