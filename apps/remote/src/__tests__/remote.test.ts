import { describe, expect, it } from 'vitest';
import {
  DICE_VALUES,
  PairRemotePayloadSchema,
  RemoteSetDicePayloadSchema,
  RemoteSetModePayloadSchema
} from '@dice-duo/shared';

describe('@dice-duo/remote contracts', () => {
  it('validates Smart Remote pairing and 1-6 dice selection payloads', () => {
    const pair = PairRemotePayloadSchema.parse({
      roomCode: 'ludo88',
      pairingPin: '4321',
      controllerLabel: 'My Phone Remote'
    });
    expect(pair.roomCode).toBe('LUDO88');
    expect(pair.pairingPin).toBe('4321');

    const mode = RemoteSetModePayloadSchema.parse({
      roomCode: 'LUDO88',
      mode: 'CUSTOM_TESTING'
    });
    expect(mode.mode).toBe('CUSTOM_TESTING');

    for (const v of DICE_VALUES) {
      const setDice = RemoteSetDicePayloadSchema.parse({
        roomCode: 'LUDO88',
        value: v
      });
      expect(setDice.value).toBe(v);
    }
  });
});
