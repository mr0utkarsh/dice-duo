import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { GameState, PlayerColor } from '@dice-duo/shared';

export interface StoredMatchSummary {
  id: string;
  roomCode: string;
  maxPlayers: number;
  isPublicMatchmaking: boolean;
  customModeUsed: boolean;
  winnerName: string;
  winnerColor: PlayerColor;
  totalTurns: number;
  rankings: Array<{
    playerId: string;
    name: string;
    color: PlayerColor;
    rank: number;
    capturesMade: number;
    sixesCount: number;
  }>;
  completedAt: string;
}

/**
 * Server-side repository that writes match results to Supabase PostgreSQL when
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are configured (and non-placeholder),
 * while always keeping a fast in-memory cache so local development and tests work
 * without external network dependencies.
 */
export class PersistenceRepository {
  private supabase: SupabaseClient | null = null;
  private readonly recentMatches: StoredMatchSummary[] = [];

  constructor() {
    const url = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (
      url &&
      serviceKey &&
      !url.includes('your-project-ref') &&
      !serviceKey.includes('placeholder')
    ) {
      this.supabase = createClient(url, serviceKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      });
    }
  }

  public isSupabaseConfigured(): boolean {
    return this.supabase !== null;
  }

  public async recordCompletedMatch(state: GameState): Promise<StoredMatchSummary | null> {
    if (state.phase !== 'GAME_OVER' || !state.winnerPlayerId) {
      return null;
    }

    const winner =
      state.players.find((p) => p.id === state.winnerPlayerId) ?? state.players[0];
    const customModeUsed = state.players.some((p) => p.stats.customRollsUsed > 0);

    const rankings = state.players
      .slice()
      .sort((a, b) => (a.finishedRank ?? 99) - (b.finishedRank ?? 99))
      .map((p, idx) => ({
        playerId: p.id,
        name: p.name,
        color: p.color,
        rank: p.finishedRank ?? idx + 1,
        capturesMade: p.stats.capturesMade,
        sixesCount: p.stats.sixesCount
      }));

    const summary: StoredMatchSummary = {
      id: state.matchId,
      roomCode: state.roomCode,
      maxPlayers: state.maxPlayers,
      isPublicMatchmaking: state.isPublicMatchmaking,
      customModeUsed,
      winnerName: winner.name,
      winnerColor: winner.color,
      totalTurns: state.turnNumber,
      rankings,
      completedAt: new Date().toISOString()
    };

    // Keep latest 50 matches in memory
    const existingIdx = this.recentMatches.findIndex((m) => m.id === summary.id);
    if (existingIdx === -1) {
      this.recentMatches.unshift(summary);
      if (this.recentMatches.length > 50) {
        this.recentMatches.pop();
      }
    }

    if (this.supabase) {
      try {
        await this.supabase.from('matches').upsert({
          id: summary.id,
          room_code: summary.roomCode,
          max_players: summary.maxPlayers,
          is_public_matchmaking: summary.isPublicMatchmaking,
          custom_mode_used: summary.customModeUsed,
          winner_name: summary.winnerName,
          winner_color: summary.winnerColor,
          total_turns: summary.totalTurns,
          rankings_json: summary.rankings,
          completed_at: summary.completedAt
        });

        const matchPlayersRows = state.players.map((p, idx) => ({
          match_id: summary.id,
          player_name: p.name,
          player_color: p.color,
          finished_rank: p.finishedRank ?? idx + 1,
          rolls_count: p.stats.rollsCount,
          sixes_count: p.stats.sixesCount,
          captures_made: p.stats.capturesMade,
          times_captured: p.stats.timesCaptured,
          custom_rolls_used: p.stats.customRollsUsed
        }));

        await this.supabase.from('match_players').insert(matchPlayersRows);
      } catch {
        // Non-fatal: keep in-memory match history available even if remote DB is unreachable
      }
    }

    return summary;
  }

  public async getRecentMatches(limit = 20): Promise<StoredMatchSummary[]> {
    if (this.supabase) {
      try {
        const { data, error } = await this.supabase
          .from('matches')
          .select('*')
          .order('completed_at', { ascending: false })
          .limit(limit);

        if (!error && Array.isArray(data) && data.length > 0) {
          return data.map((row: Record<string, unknown>) => ({
            id: String(row.id),
            roomCode: String(row.room_code),
            maxPlayers: Number(row.max_players),
            isPublicMatchmaking: Boolean(row.is_public_matchmaking),
            customModeUsed: Boolean(row.custom_mode_used),
            winnerName: String(row.winner_name),
            winnerColor: row.winner_color as PlayerColor,
            totalTurns: Number(row.total_turns),
            rankings: Array.isArray(row.rankings_json)
              ? (row.rankings_json as StoredMatchSummary['rankings'])
              : [],
            completedAt: String(row.completed_at)
          }));
        }
      } catch {
        // Fallback to in-memory recent matches
      }
    }

    return this.recentMatches.slice(0, limit);
  }
}
