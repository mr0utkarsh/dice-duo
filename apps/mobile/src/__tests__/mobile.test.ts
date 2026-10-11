import { describe, expect, it } from 'vitest';
import capacitorConfig from '../../capacitor.config.js';

describe('@dice-duo/mobile configuration', () => {
  it('defines valid Capacitor Android packaging metadata', () => {
    expect(capacitorConfig.appId).toBe('com.diceduo.ludo');
    expect(capacitorConfig.appName).toBe('DICE DUO');
    expect(capacitorConfig.webDir).toBe('dist');
  });
});
