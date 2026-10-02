import { cleanMediaTitle, extractYear } from './media-presentation';

export const TMDB_MINIMUM_CONFIDENCE_THRESHOLD = 0.65;

export interface PreparedSearchQuery {
  query: string;
  year?: string;
  imdbId?: string;
}

export interface MatchScoreResult {
  confidence: number;
  matchedTitle: string;
  originalTitle?: string;
  year?: string;
}

/**
 * Extracts IMDb identifier from strings (e.g. "tt1234567") if available in title, url, or metadata.
 */
export function extractImdbId(input?: string): string | undefined {
  if (!input) return undefined;
  const match = input.match(/\b(tt\d{7,10})\b/i);
  return match ? match[1].toLowerCase() : undefined;
}

/**
 * Prepares and normalizes an IPTV title for TMDB querying.
 * Extracts any year or external IDs and produces a clean, focused query string.
 */
export function prepareSearchQuery(rawTitle?: string): PreparedSearchQuery {
  if (!rawTitle) return { query: '' };

  const imdbId = extractImdbId(rawTitle);
  const year = extractYear(rawTitle);
  let clean = cleanMediaTitle(rawTitle);

  // If year is in the clean title, strip it out for the search query to improve API match rate
  if (year) {
    clean = clean.replace(new RegExp(`\\b${year}\\b`, 'g'), '').trim();
  }

  // Remove empty or leftover parentheses/brackets
  clean = clean.replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '').trim();

  // Strip unbracketed quality and format tokens if any remain
  clean = clean.replace(/\b(1080p|720p|480p|4K|UHD|FHD|HD|HEVC|HDR|HDR10|DV|Dolby)\b/gi, '').trim();

  // Strip trailing country codes like (US) if any slipped through
  clean = clean.replace(/[\(\[]\s*([A-Za-z]{2,3})\s*[\)\]]\s*$/gi, '').trim();

  // Remove any unclosed opening parenthesis at the end (e.g. "Elite Force (")
  clean = clean.replace(/\s*\([^)]*$/g, '').trim();

  // Strip leading and trailing non-alphanumeric separators, but preserve internal punctuation
  clean = clean.replace(/^[-*#~_+=|:–—\s/]+/, '').replace(/[-*#~_+=|:–—\s/]+$/, '').trim();

  return {
    query: clean || rawTitle.trim(),
    year,
    imdbId,
  };
}

/**
 * Normalizes strings for strict or fuzzy comparison:
 * Lowercases, strips punctuation, and removes leading articles ("the", "a", "an").
 */
export function normalizeForComparison(str?: string): string {
  if (!str) return '';
  let s = str.toLowerCase().trim();
  s = s.replace(/^[^\w\d]+|[^\w\d]+$/g, '');
  // Remove leading articles
  s = s.replace(/^(the|a|an)\s+/i, '');
  // Remove all non-alphanumeric chars for tokenization
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return s.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Calculates Dice's coefficient (bigram similarity) between two strings.
 * Returns a value between 0.0 and 1.0.
 */
export function calculateDiceSimilarity(str1: string, str2: string): number {
  const s1 = normalizeForComparison(str1);
  const s2 = normalizeForComparison(str2);

  if (s1 === s2) return 1.0;
  if (s1.length < 2 || s2.length < 2) {
    return s1 === s2 ? 1.0 : 0.0;
  }

  const getBigrams = (str: string): Map<string, number> => {
    const bigrams = new Map<string, number>();
    for (let i = 0; i < str.length - 1; i++) {
      const bigram = str.substring(i, i + 2);
      bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1);
    }
    return bigrams;
  };

  const bg1 = getBigrams(s1);
  const bg2 = getBigrams(s2);

  let intersection = 0;
  for (const [bigram, count1] of bg1.entries()) {
    if (bg2.has(bigram)) {
      intersection += Math.min(count1, bg2.get(bigram)!);
    }
  }

  const total = (s1.length - 1) + (s2.length - 1);
  return (2.0 * intersection) / total;
}

/**
 * Calculates token-level overlap similarity (Jaccard similarity on word tokens).
 */
export function calculateTokenSimilarity(str1: string, str2: string): number {
  const s1 = normalizeForComparison(str1);
  const s2 = normalizeForComparison(str2);

  if (s1 === s2) return 1.0;

  const tokens1 = new Set(s1.split(' ').filter(t => t.length > 0));
  const tokens2 = new Set(s2.split(' ').filter(t => t.length > 0));

  if (tokens1.size === 0 || tokens2.size === 0) return 0.0;

  let intersection = 0;
  tokens1.forEach(t => {
    if (tokens2.has(t)) intersection++;
  });

  const union = new Set([...tokens1, ...tokens2]).size;
  return intersection / union;
}

/**
 * Evaluates candidate TMDB item against query and target year, computing a match confidence score.
 */
export function scoreMatch(
  candidate: {
    title?: string;
    original_title?: string;
    name?: string;
    original_name?: string;
    release_date?: string;
    first_air_date?: string;
    vote_count?: number;
  },
  query: string,
  targetYear?: string,
): MatchScoreResult {
  const primaryTitle = candidate.title || candidate.name || '';
  const originalTitle = candidate.original_title || candidate.original_name;

  // Title similarity
  const dicePrimary = calculateDiceSimilarity(query, primaryTitle);
  const tokenPrimary = calculateTokenSimilarity(query, primaryTitle);
  let baseTitleScore = Math.max(dicePrimary, tokenPrimary);

  // Check original title if different
  if (originalTitle && originalTitle !== primaryTitle) {
    const diceOrig = calculateDiceSimilarity(query, originalTitle);
    const tokenOrig = calculateTokenSimilarity(query, originalTitle);
    baseTitleScore = Math.max(baseTitleScore, diceOrig, tokenOrig);
  }

  // Exact normalized match gets a solid 1.0 title score
  if (normalizeForComparison(query) === normalizeForComparison(primaryTitle) ||
      (originalTitle && normalizeForComparison(query) === normalizeForComparison(originalTitle))) {
    baseTitleScore = 1.0;
  }

  let finalConfidence = baseTitleScore;

  // Candidate release year
  const rawDate = candidate.release_date || candidate.first_air_date;
  const candidateYear = rawDate && rawDate.length >= 4 ? rawDate.substring(0, 4) : undefined;

  if (targetYear && candidateYear) {
    const targetY = parseInt(targetYear, 10);
    const candY = parseInt(candidateYear, 10);
    if (!isNaN(targetY) && !isNaN(candY)) {
      const diff = Math.abs(targetY - candY);
      if (diff === 0) {
        finalConfidence += 0.15; // Exact year match bonus
      } else if (diff === 1) {
        finalConfidence += 0.05; // 1-year margin bonus (festival/international release date variation)
      } else if (diff > 2 && diff <= 5) {
        finalConfidence -= 0.25; // Likely different edition or remake
      } else if (diff > 5) {
        finalConfidence -= 0.50; // Heavy penalty for big year mismatch
      }
    }
  }

  // Slight boost for established titles with solid vote count (tie-breaker for identical names)
  if (candidate.vote_count && candidate.vote_count > 50) {
    finalConfidence += 0.03;
  }

  finalConfidence = Math.max(0.0, Math.min(1.0, finalConfidence));

  return {
    confidence: Math.round(finalConfidence * 100) / 100,
    matchedTitle: primaryTitle,
    originalTitle,
    year: candidateYear,
  };
}
