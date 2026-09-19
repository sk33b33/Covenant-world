import { Room, type Client } from "colyseus";
import { schema, t, type SchemaType } from "@colyseus/schema";
import { BATTLE_JOIN_GRACE_MS, BATTLE_RESULT_LINGER_MS, battleResultTopic } from "../config.js";

export const BattlePlayer = schema(
  {
    name: t.string(),
    /** Identifies this player back in the zone room they were challenged in. */
    zoneSessionId: t.string(),
    ready: t.boolean().default(false),
  },
  "BattlePlayer",
);
export type BattlePlayer = SchemaType<typeof BattlePlayer>;

export const BattleState = schema(
  {
    /** "waiting" until both arrive, "active" while fighting, "resolved" once decided. */
    phase: t.string().default("waiting"),
    players: t.map(BattlePlayer),
    outcome: t.string().default(""),
    winnerZoneSessionId: t.string().default(""),
  },
  "BattleState",
);
export type BattleState = SchemaType<typeof BattleState>;

export type BattleOutcome = "played" | "forfeit" | "abandoned";

export type BattleResult = {
  battleRoomId: string;
  outcome: BattleOutcome;
  winnerZoneSessionId: string;
  participants: string[];
};

export type BattleOptions = {
  zoneRoomId: string;
  participants: Array<{ zoneSessionId: string; name: string }>;
};

/**
 * One ephemeral room per challenge. It exists only for the duration of a
 * battle and reports the result back to the zone that spawned it over
 * presence — the same channel that carries cross-zone events once zones are
 * sharded across processes.
 */
export class BattleRoom extends Room<{ state: BattleState }> {
  maxClients = 2;

  private zoneRoomId = "";
  private participants: BattleOptions["participants"] = [];
  private resolved = false;

  onCreate(options: BattleOptions) {
    // Battles are only ever created by a zone room accepting a challenge.
    // A client reaching for this room type directly gets nothing.
    if (!options?.zoneRoomId || options.participants?.length !== 2) {
      throw new Error("a battle must be created by a zone room, with two participants");
    }

    this.zoneRoomId = options.zoneRoomId;
    this.participants = options.participants;
    this.setState(new BattleState());

    this.onMessage("ready", (client) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || this.state.phase !== "active") return;

      player.ready = true;
      if (every(this.state.players, (other) => other.ready)) {
        this.resolve("played");
        this.scheduleClose();
      }
    });

    this.clock.setTimeout(() => {
      if (this.state.players.size < 2) {
        this.resolve("abandoned");
        this.disconnect();
      }
    }, BATTLE_JOIN_GRACE_MS);
  }

  onJoin(client: Client, options?: { zoneSessionId?: string }) {
    const participant = this.participants.find((candidate) => candidate.zoneSessionId === options?.zoneSessionId);
    if (!participant) throw new Error("not a participant in this battle");

    this.state.players.set(
      client.sessionId,
      new BattlePlayer({ name: participant.name, zoneSessionId: participant.zoneSessionId }),
    );

    if (this.state.players.size === 2) this.state.phase = "active";
  }

  onLeave(client: Client) {
    const leaver = this.state.players.get(client.sessionId);
    this.state.players.delete(client.sessionId);
    if (this.resolved || !leaver) return;

    const remaining = firstValue(this.state.players);
    if (remaining) {
      this.resolve("forfeit", remaining.zoneSessionId);
      this.scheduleClose();
    } else {
      this.resolve("abandoned");
    }
  }

  onDispose() {
    // The zone freezes both players for the duration of a battle, so it must
    // hear an outcome on every path out of this room — including the ones
    // that never reached a result.
    this.resolve("abandoned");
  }

  private resolve(outcome: BattleOutcome, winnerZoneSessionId?: string) {
    if (this.resolved) return;
    this.resolved = true;

    const winner = winnerZoneSessionId ?? (outcome === "played" ? this.pickWinner() : "");

    this.state.phase = "resolved";
    this.state.outcome = outcome;
    this.state.winnerZoneSessionId = winner;

    const result: BattleResult = {
      battleRoomId: this.roomId,
      outcome,
      winnerZoneSessionId: winner,
      participants: this.participants.map((participant) => participant.zoneSessionId),
    };
    this.presence.publish(battleResultTopic(this.zoneRoomId), result);
  }

  /** Leaves the result on screen briefly before sending everyone back to the overworld. */
  private scheduleClose() {
    this.clock.setTimeout(() => this.disconnect(), BATTLE_RESULT_LINGER_MS);
  }

  /**
   * PLACEHOLDER. This is where the TCG match runs — deck state, turns, the
   * real win condition. A coin flip stands in so the handoff either side of
   * it (challenge → battle → back to the overworld) can be built and tested
   * before the ruleset exists.
   */
  private pickWinner() {
    const contenders = this.participants.map((participant) => participant.zoneSessionId);
    return contenders[Math.floor(Math.random() * contenders.length)];
  }
}

function every(players: BattleState["players"], predicate: (player: BattlePlayer) => boolean) {
  let result = true;
  players.forEach((player) => {
    if (!predicate(player)) result = false;
  });
  return result;
}

function firstValue(players: BattleState["players"]) {
  let found: BattlePlayer | undefined;
  players.forEach((player) => {
    found ??= player;
  });
  return found;
}
