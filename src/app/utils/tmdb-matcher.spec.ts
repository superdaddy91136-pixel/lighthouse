import {
  prepareSearchQuery,
  scoreMatch,
  normalizeForComparison,
  calculateDiceSimilarity,
  calculateTokenSimilarity,
  TMDB_MINIMUM_CONFIDENCE_THRESHOLD,
} from './tmdb-matcher';

describe('TmdbMatcherUtils', () => {
  describe('prepareSearchQuery', () => {
    it('should extract clean query and year from movie release names', () => {
      const res = prepareSearchQuery('MOVIES/SCI-FI/Interstellar.2014.1080p.BluRay.x265', 'movie');
      expect(res.query).toBe('Interstellar');
      expect(res.year).toBe('2014');
    });

    it('should extract parent series title from TV release paths', () => {
      const res = prepareSearchQuery('SERIES/Breaking Bad/Season 01/Breaking.Bad.S01E01.1080p', 'tv');
      expect(res.query).toBe('Breaking Bad');
    });

    it('should extract IMDb IDs when present in the title string', () => {
      const res = prepareSearchQuery('Dune (2021) [tt1160419]', 'movie');
      expect(res.imdbId).toBe('tt1160419');
    });
  });

  describe('normalizeForComparison', () => {
    it('should lowercase, strip leading articles, and normalize punctuation', () => {
      expect(normalizeForComparison('The Dark Knight')).toBe('dark knight');
      expect(normalizeForComparison('A Beautiful Mind')).toBe('beautiful mind');
      expect(normalizeForComparison('Spider-Man: No Way Home')).toBe('spider man no way home');
    });
  });

  describe('scoreMatch', () => {
    it('should give maximum confidence (1.0) to exact matches', () => {
      const candidate = {
        title: 'Interstellar',
        release_date: '2014-11-05',
        vote_count: 35000,
      };
      const result = scoreMatch(candidate, 'Interstellar', '2014', 'movie');
      expect(result.confidence).toBeGreaterThanOrEqual(1.0);
      expect(result.confidence).toBeGreaterThanOrEqual(TMDB_MINIMUM_CONFIDENCE_THRESHOLD);
    });

    it('should disambiguate movies with identical or similar titles using release year', () => {
      const bladeRunner1982 = {
        title: 'Blade Runner',
        release_date: '1982-06-25',
        vote_count: 14000,
      };
      const bladeRunner2049 = {
        title: 'Blade Runner 2049',
        release_date: '2017-10-06',
        vote_count: 13000,
      };

      const scoreFor2049 = scoreMatch(bladeRunner2049, 'Blade Runner 2049', '2017', 'movie');
      const scoreFor1982 = scoreMatch(bladeRunner1982, 'Blade Runner 2049', '2017', 'movie');

      expect(scoreFor2049.confidence).toBeGreaterThan(scoreFor1982.confidence);
      expect(scoreFor2049.confidence).toBeGreaterThanOrEqual(TMDB_MINIMUM_CONFIDENCE_THRESHOLD);
    });

    it('should not penalize TV series for season release years following premiere', () => {
      // Stranger Things premiered in 2016. Season 4 was released in 2022.
      const candidate = {
        name: 'Stranger Things',
        first_air_date: '2016-07-15',
        vote_count: 18000,
      };
      const result = scoreMatch(candidate, 'Stranger Things', '2022', 'tv');
      expect(result.confidence).toBeGreaterThanOrEqual(TMDB_MINIMUM_CONFIDENCE_THRESHOLD);
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('should penalize TV candidate that premiered after the target year', () => {
      const futureCandidate = {
        name: 'Stranger Things',
        first_air_date: '2025-01-01',
        vote_count: 10,
      };
      const result = scoreMatch(futureCandidate, 'Stranger Things', '2016', 'tv');
      expect(result.confidence).toBeLessThan(0.75);
    });

    it('should reject completely unrelated titles below minimum threshold', () => {
      const candidate = {
        title: 'The Room',
        release_date: '2003-03-03',
        vote_count: 1000,
      };
      const result = scoreMatch(candidate, 'Interstellar', '2014', 'movie');
      expect(result.confidence).toBeLessThan(TMDB_MINIMUM_CONFIDENCE_THRESHOLD);
    });
  });
});
