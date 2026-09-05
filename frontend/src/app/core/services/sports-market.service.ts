import { Injectable, signal } from '@angular/core';

export type MatchState = 'live' | 'upcoming';
export type MatchOutcome = 'home' | 'draw' | 'away';

export interface FootballMatch {
  id: string;
  competition: string;
  home: string;
  away: string;
  state: MatchState;
  kickoff: string;
  minute?: number;
  homeScore: number;
  awayScore: number;
  homeOdds: number;
  drawOdds: number;
  awayOdds: number;
  markets: number;
}

interface FixtureTemplate {
  id: string;
  competition: string;
  home: string;
  away: string;
  state: MatchState;
  kickoff: string;
  homeOdds: number;
  drawOdds: number;
  awayOdds: number;
  markets: number;
}

/**
 * A local rotating market board for the dashboard while a licensed odds feed
 * is being integrated. It makes the dashboard feel live without presenting
 * the sample data as an external sports feed.
 */
@Injectable({ providedIn: 'root' })
export class SportsMarketService {
  private readonly fixturePool: FixtureTemplate[] = [
    // ---- Live ----
    { id: 'l-ars-che', competition: 'Premier League', home: 'Arsenal', away: 'Chelsea', state: 'live', kickoff: 'Today', homeOdds: 2.05, drawOdds: 3.45, awayOdds: 3.60, markets: 148 },
    { id: 'l-liv-mci', competition: 'Premier League', home: 'Liverpool', away: 'Manchester City', state: 'live', kickoff: 'Today', homeOdds: 2.62, drawOdds: 3.55, awayOdds: 2.55, markets: 162 },
    { id: 'l-rma-atm', competition: 'LaLiga', home: 'Real Madrid', away: 'Atletico Madrid', state: 'live', kickoff: 'Today', homeOdds: 1.85, drawOdds: 3.60, awayOdds: 4.40, markets: 155 },
    { id: 'l-int-juv', competition: 'Serie A', home: 'Inter Milan', away: 'Juventus', state: 'live', kickoff: 'Today', homeOdds: 2.20, drawOdds: 3.20, awayOdds: 3.45, markets: 140 },
    { id: 'l-bay-dor', competition: 'Bundesliga', home: 'Bayern Munich', away: 'Borussia Dortmund', state: 'live', kickoff: 'Today', homeOdds: 1.72, drawOdds: 4.00, awayOdds: 4.60, markets: 151 },
    { id: 'l-gor-afc', competition: 'Kenya Premier League', home: 'Gor Mahia', away: 'AFC Leopards', state: 'live', kickoff: 'Today', homeOdds: 1.95, drawOdds: 3.30, awayOdds: 4.05, markets: 86 },
    { id: 'l-tus-ken', competition: 'Kenya Premier League', home: 'Tusker FC', away: 'Kariobangi Sharks', state: 'live', kickoff: 'Today', homeOdds: 1.80, drawOdds: 3.40, awayOdds: 4.50, markets: 78 },
    { id: 'l-psg-mar', competition: 'Ligue 1', home: 'Paris Saint-Germain', away: 'Marseille', state: 'live', kickoff: 'Today', homeOdds: 1.55, drawOdds: 4.20, awayOdds: 5.60, markets: 144 },

    // ---- Upcoming ----
    { id: 'u-mun-tot', competition: 'Premier League', home: 'Manchester United', away: 'Tottenham', state: 'upcoming', kickoff: 'Today, 19:30', homeOdds: 2.45, drawOdds: 3.50, awayOdds: 2.80, markets: 158 },
    { id: 'u-new-avl', competition: 'Premier League', home: 'Newcastle United', away: 'Aston Villa', state: 'upcoming', kickoff: 'Today, 20:00', homeOdds: 2.30, drawOdds: 3.40, awayOdds: 3.05, markets: 146 },
    { id: 'u-bar-sev', competition: 'LaLiga', home: 'Barcelona', away: 'Sevilla', state: 'upcoming', kickoff: 'Today, 21:45', homeOdds: 1.48, drawOdds: 4.40, awayOdds: 6.20, markets: 152 },
    { id: 'u-mil-nap', competition: 'Serie A', home: 'AC Milan', away: 'Napoli', state: 'upcoming', kickoff: 'Today, 22:00', homeOdds: 2.40, drawOdds: 3.30, awayOdds: 2.95, markets: 139 },
    { id: 'u-lev-rbl', competition: 'Bundesliga', home: 'Bayer Leverkusen', away: 'RB Leipzig', state: 'upcoming', kickoff: 'Tomorrow, 16:30', homeOdds: 2.10, drawOdds: 3.60, awayOdds: 3.30, markets: 133 },
    { id: 'u-bmt-pos', competition: 'Kenya Premier League', home: 'Bandari FC', away: 'Posta Rangers', state: 'upcoming', kickoff: 'Tomorrow, 15:00', homeOdds: 2.15, drawOdds: 3.10, awayOdds: 3.40, markets: 74 },
    { id: 'u-uld-nai', competition: 'Kenya Premier League', home: 'Ulinzi Stars', away: 'Nairobi City Stars', state: 'upcoming', kickoff: 'Tomorrow, 17:00', homeOdds: 2.35, drawOdds: 3.05, awayOdds: 3.15, markets: 71 },
    { id: 'u-ars-rma', competition: 'UEFA Champions League', home: 'Arsenal', away: 'Real Madrid', state: 'upcoming', kickoff: 'Tomorrow, 23:00', homeOdds: 2.70, drawOdds: 3.45, awayOdds: 2.55, markets: 176 },
    { id: 'u-bay-psg', competition: 'UEFA Champions League', home: 'Bayern Munich', away: 'Paris Saint-Germain', state: 'upcoming', kickoff: 'Tomorrow, 23:00', homeOdds: 2.05, drawOdds: 3.70, awayOdds: 3.40, markets: 172 },
    { id: 'u-rom-laz', competition: 'Serie A', home: 'AS Roma', away: 'Lazio', state: 'upcoming', kickoff: 'Tomorrow, 19:00', homeOdds: 2.50, drawOdds: 3.15, awayOdds: 2.90, markets: 128 },
    { id: 'u-ath-rso', competition: 'LaLiga', home: 'Athletic Bilbao', away: 'Real Sociedad', state: 'upcoming', kickoff: 'Tomorrow, 20:30', homeOdds: 2.25, drawOdds: 3.20, awayOdds: 3.25, markets: 124 },
    { id: 'u-bri-wol', competition: 'Premier League', home: 'Brighton', away: 'Wolves', state: 'upcoming', kickoff: 'Tomorrow, 18:00', homeOdds: 1.90, drawOdds: 3.55, awayOdds: 4.10, markets: 137 },
    { id: 'u-lyo-mon', competition: 'Ligue 1', home: 'Lyon', away: 'Monaco', state: 'upcoming', kickoff: 'Tomorrow, 21:00', homeOdds: 2.60, drawOdds: 3.40, awayOdds: 2.62, markets: 119 },
    { id: 'u-por-ben', competition: 'Primeira Liga', home: 'Porto', away: 'Benfica', state: 'upcoming', kickoff: 'Tomorrow, 22:15', homeOdds: 2.35, drawOdds: 3.25, awayOdds: 2.95, markets: 131 },
    { id: 'u-aja-psv', competition: 'Eredivisie', home: 'Ajax', away: 'PSV Eindhoven', state: 'upcoming', kickoff: 'Tomorrow, 18:45', homeOdds: 2.55, drawOdds: 3.60, awayOdds: 2.50, markets: 116 },
    { id: 'u-gal-fen', competition: 'Super Lig', home: 'Galatasaray', away: 'Fenerbahce', state: 'upcoming', kickoff: 'Tomorrow, 20:00', homeOdds: 2.28, drawOdds: 3.30, awayOdds: 3.10, markets: 122 }
  ];

  private fixtureCursor = 0;
  private refreshCount = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  readonly matches = signal<FootballMatch[]>([
    ...this.getFixtures('live', 6),
    ...this.getFixtures('upcoming', 12)
  ]);

  start(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => this.refreshMarkets(), 5000);
  }

  stop(): void {
    if (!this.refreshTimer) return;
    clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  private refreshMarkets(): void {
    this.refreshCount += 1;

    this.matches.update(matches => matches.map((match, index) => {
      // A finished match leaves the board and a fresh kick-off takes its slot.
      if (match.state === 'live' && (match.minute ?? 0) >= 90) {
        return this.getNextFixture('live', true);
      }
      // Rotate a couple of upcoming fixtures periodically so the board moves.
      if (match.state === 'upcoming' && index % 5 === 0 && this.refreshCount % 6 === 0) {
        return this.getNextFixture('upcoming');
      }

      const next = { ...match };

      if (match.state === 'live') {
        // Roughly a minute of match time per tick.
        next.minute = Math.min(90, (match.minute ?? 0) + 1);

        // Goals are rare — about one every twenty minutes of play, and the
        // stronger side (shorter odds) is a little more likely to score.
        if (Math.random() < 0.05) {
          const homeFavoured = match.homeOdds < match.awayOdds;
          const homeScores = Math.random() < (homeFavoured ? 0.6 : 0.4);
          if (homeScores) next.homeScore += 1; else next.awayScore += 1;
        }
      }

      // Odds drift, and lean towards whoever is ahead and how little time is left.
      const lead = next.homeScore - next.awayScore;
      const elapsed = next.state === 'live' ? Math.min(1, (next.minute ?? 0) / 90) : 0;
      const pressure = lead === 0 ? 0 : Math.sign(lead) * Math.min(0.5, Math.abs(lead) * 0.16 * (0.4 + elapsed));
      const drift = () => 1 + (Math.random() - 0.5) * 0.03;
      const clamp = (odds: number) => Math.max(1.01, Number(odds.toFixed(2)));

      next.homeOdds = clamp(match.homeOdds * drift() * (1 - pressure * 0.35));
      next.awayOdds = clamp(match.awayOdds * drift() * (1 + pressure * 0.35));
      next.drawOdds = clamp(match.drawOdds * drift() * (1 + Math.abs(pressure) * 0.5));

      return next;
    }));
  }

  private getFixtures(state: MatchState, count: number): FootballMatch[] {
    return Array.from({ length: count }, () => this.getNextFixture(state));
  }

  private getNextFixture(state: MatchState, fresh = false): FootballMatch {
    const fixtures = this.fixturePool.filter(fixture => fixture.state === state);
    const fixture = fixtures[this.fixtureCursor % fixtures.length];
    this.fixtureCursor += 1;
    const randomiseOdds = (odds: number) => Number((odds * (0.97 + Math.random() * 0.06)).toFixed(2));
    const minute = state === 'live' ? (fresh ? 1 + Math.floor(Math.random() * 8) : 6 + Math.floor(Math.random() * 70)) : undefined;
    const openingGoals = () => (fresh ? 0 : (Math.random() < 0.45 ? 0 : Math.floor(Math.random() * 3)));

    return {
      ...fixture,
      id: `${fixture.id}-${this.fixtureCursor}`,
      minute,
      homeScore: state === 'live' ? Math.floor(Math.random() * 3) : 0,
      awayScore: state === 'live' ? Math.floor(Math.random() * 3) : 0,
      homeOdds: randomiseOdds(fixture.homeOdds),
      drawOdds: randomiseOdds(fixture.drawOdds),
      awayOdds: randomiseOdds(fixture.awayOdds)
    };
  }
}
