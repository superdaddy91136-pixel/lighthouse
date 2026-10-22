import {
  cleanMediaTitle,
  extractYear,
  extractQuality,
  stripFileExtensions,
  stripFolderPaths,
  replaceSceneSeparators,
  stripProviderPrefixes,
  parseMediaTitle,
} from './media-presentation';

describe('MediaPresentationUtils', () => {
  describe('cleanMediaTitle', () => {
    it('should clean bracketed quality and release tags from movie titles', () => {
      const raw = '[4K UHD] Interstellar (2014) REMUX';
      expect(cleanMediaTitle(raw)).toBe('Interstellar');
      expect(extractYear(raw)).toBe('2014');
    });

    it('should strip folder/directory paths, dots, and codecs', () => {
      const raw = 'MOVIES/SCI-FI/Interstellar.2014.1080p.BluRay.x265';
      expect(cleanMediaTitle(raw)).toBe('Interstellar');
      expect(extractYear(raw)).toBe('2014');
    });

    it('should strip full language prefixes and web-dl release tags', () => {
      const raw = 'ENGLISH - The.Dark.Knight.2008.WEB-DL';
      expect(cleanMediaTitle(raw)).toBe('The Dark Knight');
      expect(extractYear(raw)).toBe('2008');
    });

    it('should strip series directory hierarchy and episode release info', () => {
      const raw = 'SERIES/Breaking Bad/Season 01/Breaking.Bad.S01E01.1080p';
      expect(cleanMediaTitle(raw)).toBe('Breaking Bad');
    });

    it('should strip country pipe prefixes and trailing season/episode tags', () => {
      const raw = 'US | Stranger Things | S01E01';
      expect(cleanMediaTitle(raw)).toBe('Stranger Things');
    });

    it('should preserve legitimate numbers that belong to the title', () => {
      expect(cleanMediaTitle('Blade Runner 2049 (2017) [1080p]')).toBe('Blade Runner 2049');
      expect(extractYear('Blade Runner 2049 (2017) [1080p]')).toBe('2017');

      expect(cleanMediaTitle('2001: A Space Odyssey (1968)')).toBe('2001: A Space Odyssey');
      expect(extractYear('2001: A Space Odyssey (1968)')).toBe('1968');

      expect(cleanMediaTitle('1917 (2019)')).toBe('1917');
      expect(extractYear('1917 (2019)')).toBe('2019');

      expect(cleanMediaTitle('Se7en (1995)')).toBe('Se7en');
      expect(cleanMediaTitle("Ocean's 11 (2001)")).toBe("Ocean's 11");
    });

    it('should preserve legitimate punctuation such as colons and hyphens', () => {
      expect(cleanMediaTitle('Spider-Man: Across the Spider-Verse')).toBe('Spider-Man: Across the Spider-Verse');
      expect(cleanMediaTitle('Mission: Impossible - Dead Reckoning Part One (2023)')).toBe('Mission: Impossible - Dead Reckoning Part One');
      expect(cleanMediaTitle('Dune: Part Two (2024) [4K UHD]')).toBe('Dune: Part Two');
    });

    it('should preserve non-English titles and characters', () => {
      expect(cleanMediaTitle('Amélie (2001)')).toBe('Amélie');
      expect(cleanMediaTitle('D+ - Moving (KR) - S01E08 - Black')).toBe('Moving');
      expect(cleanMediaTitle('千と千尋の神隠し (2001)')).toBe('千と千尋の神隠し');
    });

    it('should strip file extensions cleanly', () => {
      expect(cleanMediaTitle('The.Matrix.1999.2160p.UHD.HDR.x265-EVO.mkv')).toBe('The Matrix');
      expect(extractYear('The.Matrix.1999.2160p.UHD.HDR.x265-EVO.mkv')).toBe('1999');

      expect(cleanMediaTitle('Gladiator.2000.REMASTERED.1080p.BluRay.x264.mkv')).toBe('Gladiator');
      expect(extractYear('Gladiator.2000.REMASTERED.1080p.BluRay.x264.mkv')).toBe('2000');
    });

    it('should be deterministic when applied repeatedly', () => {
      const noisy = '4K-NF - Stranger Things S04 2160p';
      const clean1 = cleanMediaTitle(noisy);
      const clean2 = cleanMediaTitle(clean1);
      expect(clean1).toBe('Stranger Things');
      expect(clean2).toBe('Stranger Things');
    });
  });

  describe('extractQuality', () => {
    it('should extract 4K UHD quality correctly', () => {
      expect(extractQuality('[4K UHD] Interstellar')).toBe('4K UHD');
      expect(extractQuality('Interstellar 2160p')).toBe('4K UHD');
    });

    it('should extract 1080p quality correctly', () => {
      expect(extractQuality('The Dark Knight 1080p BluRay')).toBe('1080p');
      expect(extractQuality('The Dark Knight FHD')).toBe('1080p');
    });

    it('should extract 720p quality correctly', () => {
      expect(extractQuality('Breaking Bad 720p')).toBe('720p');
      expect(extractQuality('Breaking Bad HD')).toBe('720p');
    });

    it('should return undefined if no quality indicator exists', () => {
      expect(extractQuality('Interstellar')).toBeUndefined();
    });
  });

  describe('parseMediaTitle', () => {
    it('should return structured metadata for TV series with season and episode numbers', () => {
      const parsed = parseMediaTitle('SERIES/Breaking Bad/Season 01/Breaking.Bad.S01E08.1080p');
      expect(parsed.cleanTitle).toBe('Breaking Bad');
      expect(parsed.season).toBe(1);
      expect(parsed.episode).toBe(8);
      expect(parsed.quality).toBe('1080p');
    });
  });
});
