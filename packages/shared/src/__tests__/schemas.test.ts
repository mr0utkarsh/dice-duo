import { describe, expect, it } from 'vitest';
import {
  CreateRoomPayloadSchema,
  DiceValueSchema,
  RollDicePayloadSchema,
  RoomCodeSchema
} from '../index.js';

describe('@dice-duo/shared schemas', () => {
  it('validates 6-character alphanumeric room codes', () => {
    expect(RoomCodeSchema.parse('ab12cd')).toBe('AB12CD');
    expect(() => RoomCodeSchema.parse('SHORT')).toThrow();
    expect(() => RoomCodeSchema.parse('TOO-LONG')).toThrow();
  });

  it('rejects client-supplied dice values on RollDicePayloadSchema (.strict())', () => {
    expect(RollDicePayloadSchema.parse({ roomCode: 'LUDO99' })).toEqual({
      roomCode: 'LUDO99'
    });
    expect(() =>
      RollDicePayloadSchema.parse({ roomCode: 'LUDO99', value: 6 })
    ).toThrow();
  });

  it('validates dice values strictly from 1 to 6', () => {
    for (const v of [1, 2, 3, 4, 5, 6]) {
      expect(DiceValueSchema.parse(v)).toBe(v);
    }
    expect(() => DiceValueSchema.parse(0)).toThrow();
    expect(() => DiceValueSchema.parse(7)).toThrow();
  });

  it('applies sensible defaults to CreateRoomPayloadSchema', () => {
    const parsed = CreateRoomPayloadSchema.parse({ playerName: 'Utkarsh' });
    expect(parsed.maxPlayers).toBe(2);
    expect(parsed.isPublicMatchmaking).toBe(false);
    expect(parsed.allowCustomTestingMode).toBe(true);
  });
});
