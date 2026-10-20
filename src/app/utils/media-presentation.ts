import { Channel } from "../models/channel";

/**
 * Normalizes and cleans raw IPTV/VOD channel and movie titles for presentation.
 * Removes provider prefixes, repeated symbols, language tags, technical codes,
 * while preserving meaningful franchise information and subtitles.
 *
 * Example: "-TOP - Toy Story 5" -> "Toy Story 5"
 * Example: "|EN| Dune: Part Two (2024) [4K]" -> "Dune: Part Two"
 */
export function cleanMediaTitle(raw?: string): string {
  if (!raw) return "Untitled";

  let title = raw.trim();

  // 1. Replace dot-separated or underscore-separated scene release names if detected
  // e.g. "Toy.Story.5.2024.1080p" -> "Toy Story 5 2024 1080p"
  if (/^[A-Za-z0-9]+([._][A-Za-z0-9]+){3,}$/.test(title)) {
    title = title.replace(/[._]/g, " ");
  }

  // 2. Iteratively remove common provider tags and prefixes:
  for (let pass = 0; pass < 4; pass++) {
    const prev = title;

    // Standard category and streaming prefixes
    title = title.replace(
      /^[-*#~_+=|\s]*\b(TOP|VIP|NEW|EXCLUSIVE|PREMIUM|VOD|CINEMA|MOVIES?|SERIES?|FILMS?)\b[-*#~_+=|\s:]*/i,
      "",
    );

    // Platform prefixes: 4K-NF, 4K-D+, D+, NF, ATVP, AMZN, DSNP, HMAX, MAX, HBO, HULU, BBC, etc.
    title = title.replace(
      /^[-*#~_+=|\s]*\b(4K-)?(D\+|P\+|C\+|MGM\+|CANAL\+|PARAMOUNT\+?|DISNEY\+?|APPLE(\s*TV\+?)?|NF|NETFLIX|ATVP|AMZN|PRIME(\s*VIDEO)?|DSNP|HMAX|MAX|HBO(\s*MAX)?|HULU|PEACOCK|BBC|SKY|CRUNCHYROLL|CR|STARZ|SHOWTIME)\b[-*#~_+=|\s:]*/i,
      "",
    );

    // Remove country/language bracket/pipe tags: "|EN|", "[EN]", "EN |", "US -", "FR:", "UK |", "LATAM |", etc.
    title = title.replace(/^\|?[A-Z]{2,4}\|?\s*[-:|]\s*/g, "");
    title = title.replace(/^\[[A-Z]{2,4}\]\s*[-:|]?\s*/g, "");
    title = title.replace(/\|[A-Z]{2,4}\|\s*/g, "");

    // Remove leading resolution / format prefix tags: "4K -", "[4K]", "UHD |", "1080p -", etc.
    title = title.replace(
      /^[-*#~_+=|\s]*(\[?(4K|UHD|1080p|FHD|720p|HD)\]?)[-*#~_+=|\s:]+/i,
      "",
    );

    title = title.replace(/^[-*#~_+=|:–—\s]+/, "");
    if (title === prev) break;
  }

  // Remove technical brackets: "[1080p]", "[4K]", "[HEVC]", "[HDR]", "[x265]", "[Multi-Sub]", etc.
  title = title.replace(
    /\[\s*(4K|UHD|1080p|FHD|720p|HD|HEVC|H264|x265|x264|HDR|HDR10|DV|Dolby|WEBRip|BluRay|HDTV|REMUX|MULTI|VOSTFR|Subbed|Dubbed)[^\]]*\]/gi,
    "",
  );

  // Remove standalone bracketed or parenthesized years at the end or enclosed in brackets: e.g. "(2024)", "[2024]"
  title = title.replace(/[\(\[]\s*(19\d\d|20\d\d)\s*[\)\]]/g, "");

  // Remove trailing country/region/language tags in parentheses or brackets: e.g. "(US)", "(GB)", "(TW)", "[US]", "(Multi)", "(Sub)"
  title = title.replace(/[\(\[]\s*([A-Za-z]{2,3}|Multi|Sub|Dub|VF|VOSTFR|Eng)\s*[\)\]]\s*$/gi, "");

  // Remove season/episode markers from series titles: "Season 1", "Seasons 1-5", "S01-S05", "S01 E01", "Complete Series"
  title = title.replace(/\b(Season|Seasons|Series)\s*\d+(\s*[-–]\s*\d+)?\b/gi, "");
  title = title.replace(/\bS\d{1,2}(\s*[-–]\s*S?\d{1,2})?\b/gi, "");
  title = title.replace(/\b(Complete\s+Series|Complete\s+Season|Mini-Series|Miniseries)\b/gi, "");

  // Remove scene tags at end of string: "WEBRip", "BluRay", "x264", "1080p", "4K", etc.
  title = title.replace(/\b(WEBRip|BluRay|HDTV|BRRip|DVDRip|REMUX|x264|x265|HEVC|1080p|720p|4K|UHD|FHD)\b/gi, "");

  // 3. Strip remaining leading/trailing symbols, separators, or whitespace
  title = title.replace(/^[-*#~_+=|:–—\s]+/, "");
  title = title.replace(/[-*#~_+=|:–—\s]+$/, "");

  // Collapse multiple spaces
  title = title.replace(/\s{2,}/g, " ").trim();

  // If cleaning resulted in an empty string, fallback to raw
  return title.length > 0 ? title : raw.trim();
}

/**
 * Extracts a 4-digit release year only when explicitly present in parentheses or brackets.
 * Returns undefined if no year exists to prevent inventing false metadata.
 */
export function extractYear(rawTitle?: string): string | undefined {
  if (!rawTitle) return undefined;
  const match = rawTitle.match(/[\(\[]\s*(19\d\d|20\d\d)\s*[\)\]]/);
  return match ? match[1] : undefined;
}

/**
 * Extracts quality indicators (4K UHD, 1080p, 720p, HD) only when reliably present.
 * Returns undefined if missing.
 */
export function extractQuality(rawTitle?: string): string | undefined {
  if (!rawTitle) return undefined;
  if (/\b(4K|UHD)\b/i.test(rawTitle)) return "4K UHD";
  if (/\b(1080p|FHD)\b/i.test(rawTitle)) return "1080p";
  if (/\b(720p)\b/i.test(rawTitle)) return "720p";
  if (/\b(HD)\b/i.test(rawTitle)) return "HD";
  return undefined;
}

/**
 * Cleans category / genre labels from provider noise.
 * Returns undefined if generic (e.g. "ALL", "VOD") to avoid awkward badges.
 */
export function cleanCategoryTitle(category?: string): string | undefined {
  if (!category) return undefined;
  let clean = category
    .replace(/^[-*#~_+=|\s]*\b(VOD|MOVIES?|SERIES?|CHANNELS?|LIVE)\b[-*#~_+=|\s:]*/gi, "")
    .replace(/^\|?[A-Z]{2,4}\|?\s*[-:|]\s*/g, "")
    .replace(/Movies|Series|VOD/gi, "")
    .replace(/^[-*#~_+=|:–—\s]+/, "")
    .replace(/[-*#~_+=|:–—\s]+$/, "")
    .trim();

  if (clean.length < 2 || /^(all|vod|movies|series)$/i.test(clean)) {
    return undefined;
  }
  return clean;
}

/**
 * Returns the best available synopsis from the catalog data if one exists.
 * Returns undefined if not available so generic filler text is never shown.
 */
export function selectSynopsis(channel: Channel): string | undefined {
  const anyChannel = channel as any;
  if (
    anyChannel.overview &&
    typeof anyChannel.overview === "string" &&
    anyChannel.overview.trim().length > 0
  ) {
    return anyChannel.overview.trim();
  }
  if (
    anyChannel.description &&
    typeof anyChannel.description === "string" &&
    anyChannel.description.trim().length > 0
  ) {
    return anyChannel.description.trim();
  }
  if (
    anyChannel.plot &&
    typeof anyChannel.plot === "string" &&
    anyChannel.plot.trim().length > 0
  ) {
    return anyChannel.plot.trim();
  }
  return undefined;
}

const BRAND_PREFIX_REGEX = /^[\[\(|]?\s*(?:4K-)?(?:D\+|P\+|C\+|MGM\+|CANAL\+|PARAMOUNT\+?|DISNEY\+?|APPLE(\s*TV\+?)?|NF|NETFLIX|ATVP|AMZN|PRIME(\s*VIDEO)?|DSNP|HMAX|MAX|HBO(\s*MAX)?|HULU|PEACOCK|BBC|SKY|CRUNCHYROLL|CR|STARZ|SHOWTIME)\s*[\]\)|]?\s*[-:|–—\/]?\s*/i;

// Generic category words MUST be followed by a separator or be bracketed to avoid stripping legitimate title words like "Top Gun", "New Girl", "Show Me A Hero"
const CATEGORY_PREFIX_REGEX = /^(?:[\[\(|]\s*(?:TOP|VIP|NEW|EXCLUSIVE|PREMIUM|VOD|SERIES?|TV|SHOWS?|FILMS?|CINEMA)\s*[\]\)|]\s*[-:|–—\/]?|(?:TOP|VIP|NEW|EXCLUSIVE|PREMIUM|VOD|SERIES?|TV|SHOWS?|FILMS?|CINEMA)\s*[-:|–—\/])\s*/i;

const LEADING_TAG_REGEX = /^(?:\|[A-Za-z0-9\s_-]+\||\([A-Za-z0-9\s_-]+\)|\[[A-Za-z0-9\s_-]+\])\s*[-:|–—\/]?\s*/;

const RESOLUTION_PREFIX_REGEX = /^(?:\[?(?:4K|UHD|1080p|FHD|720p|HD)\]?)\s*[-:|–—\/]\s*/i;

/**
 * Normalizes title casing while preserving uppercase roman numerals and acronyms,
 * and keeping minor grammatical words lowercase.
 */
export function toTitleCase(str?: string): string {
  if (!str) return '';
  const minorWords = new Set([
    'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'so', 'the', 'to', 'up', 'yet'
  ]);
  const romanNumerals = /^(?=[MDCLXVI])M*(C[MD]|D?C{0,3})(X[CL]|L?X{0,3})(I[XV]|V?I{0,3})$/i;

  const words = str.trim().split(/\s+/);
  return words.map((word, index) => {
    const match = word.match(/^([("']*)(.*?)([)"']*)$/);
    if (!match) return word;
    const prefix = match[1];
    const core = match[2];
    const suffix = match[3];

    if (!core) return word;

    if (core.length > 1 && romanNumerals.test(core)) {
      return prefix + core.toUpperCase() + suffix;
    }

    const lower = core.toLowerCase();
    const prevWord = index > 0 ? words[index - 1] : '';
    const isAfterSeparator = prevWord.endsWith(':') || prevWord.endsWith('-') || prevWord.endsWith('—');

    if (index > 0 && index < words.length - 1 && minorWords.has(lower) && !isAfterSeparator) {
      return prefix + lower + suffix;
    }

    if (/^[A-Z]{2,4}$/.test(core)) {
      return prefix + core + suffix;
    }

    return prefix + core.charAt(0).toUpperCase() + core.slice(1).toLowerCase() + suffix;
  }).join(' ');
}

/**
 * Strips provider branding, streaming platform identifiers, and category noise.
 */
export function stripProviderPrefixes(str?: string): string {
  if (!str) return '';
  let s = str.trim();
  for (let pass = 0; pass < 4; pass++) {
    const prev = s;
    s = s.replace(BRAND_PREFIX_REGEX, '');
    s = s.replace(CATEGORY_PREFIX_REGEX, '');
    s = s.replace(LEADING_TAG_REGEX, '');
    s = s.replace(RESOLUTION_PREFIX_REGEX, '');
    s = s.replace(/^[-*#~_+=|:–—\s/]+/, '');
    if (s === prev) break;
  }
  return s.trim();
}

/**
 * Sanitizes a TV show title by stripping provider prefixes, trailing year markers,
 * technical tags, and redundant season suffixes.
 */
export function sanitizeShowTitle(rawTitle?: string): string {
  if (!rawTitle) return '';
  let title = stripProviderPrefixes(rawTitle);

  // Remove trailing year if present: (2023) or [2023]
  title = title.replace(/\s*[\(\[]\s*(19\d\d|20\d\d)\s*[\)\]]/g, '');
  // Remove trailing country tags: (US), (KR), [UK]
  title = title.replace(/\s*[\(\[]\s*([A-Za-z]{2,3}|Multi|Sub|Dub|VF|VOSTFR)\s*[\)\]]\s*$/gi, '');
  // Remove technical brackets: [4K], [1080p], etc.
  title = title.replace(/\s*\[\s*(?:4K|UHD|1080p|FHD|720p|HD|HEVC|HDR|HDR10|DV|Dolby)[^\]]*\]/gi, '');
  // Strip trailing season markers like "Season 1", "S1", "Series 1"
  title = title.replace(/\s*[-–—:|/]?\s*\b(?:Season|Series)\s*\d+\b/gi, '');
  title = title.replace(/\s*[-–—:|/]?\s*\bS\d{1,2}\b/gi, '');
  title = title.replace(/^[-*#~_+=|:–—\s/]+/, '').replace(/[-*#~_+=|:–—\s/]+$/, '').trim();

  return toTitleCase(title) || rawTitle.trim();
}

/**
 * Cleans up raw TV episode titles by stripping provider prefixes, duplicate show names,
 * redundant season/episode notation, and leading episode numbers.
 */
export function sanitizeEpisodeTitle(
  rawTitle?: string,
  showTitle?: string,
  episodeNum?: number,
  seasonNum?: number
): string {
  if (!rawTitle) return '';
  let title = rawTitle.trim();

  // Run cleanup passes to handle provider prefixes appearing before or after show/season/episode tags
  for (let pass = 0; pass < 3; pass++) {
    const prev = title;
    title = stripProviderPrefixes(title);

    // 1. Remove duplicated series name if at beginning of episode title
    const cleanShow = sanitizeShowTitle(showTitle);
    if (cleanShow) {
      const escapedShow = cleanShow.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const showRegex = new RegExp(`^\\s*${escapedShow}\\s*[-:|–—/]?\\s*`, 'i');
      title = title.replace(showRegex, '');
    }
    if (showTitle) {
      const escapedRawShow = showTitle.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rawShowRegex = new RegExp(`^\\s*${escapedRawShow}\\s*[-:|–—/]?\\s*`, 'i');
      title = title.replace(rawShowRegex, '');
    }

    // 2. Remove redundant season & episode notation
    // Matches: S01E11, S1 E11, s1 e11, Season 1 Episode 11, Episode 11, Ep 11, 1x11, 01x11
    const redundantNotationRegex = /^\s*[-:|–—/]?\s*(?:(?:Season\s*\d+\s*[,–-]?\s*)?(?:Episode\s*\d+|Ep\s*\d+|E\d{1,3}|S\d{1,2}\s*E\d{1,3}|\d{1,2}x\d{1,3}))\s*[-:|–—/.]?\s*/i;
    title = title.replace(redundantNotationRegex, '');
    title = title.replace(/^\s*(?:s\d{1,2}\s*e\d{1,3}|ep(?:isode)?\s*\d+|\d{1,2}x\d{1,3})\s*[-:|–—/.]?\s*/i, '');

    // 3. Remove leading episode number prefix if matching episodeNum: e.g. "11 - The Romanticist" or "11. The Romanticist"
    if (episodeNum != null) {
      const epNumPattern = new RegExp(`^\\s*0*${episodeNum}\\s*[-–—:|/.]\\s*`, 'i');
      title = title.replace(epNumPattern, '');
    }

    if (title === prev) break;
  }

  // 4. Strip technical tags at end of episode title: [1080p], [4K], etc.
  title = title.replace(/\s*\[\s*(?:4K|UHD|1080p|FHD|720p|HD|HEVC|HDR)[^\]]*\]/gi, '');
  title = title.replace(/^[-*#~_+=|:–—/·.\s]+/, '');
  title = title.replace(/[-*#~_+=|:–—/·.\s]+$/, '');
  title = title.trim();

  // If after removing redundant metadata there is a real title left, normalize capitalization
  if (title.length > 0) {
    return toTitleCase(title);
  }

  return '';
}

/**
 * Formats a clean player episode label with primary (show) and secondary (episode) titles.
 * Example:
 *   Show: "D+ - Moving"
 *   Episode: "D+ - s1 e11 the romanticist"
 *   Result:
 *     primary: "Moving"
 *     secondary: "- 11. The Romanticist"
 *     full: "Moving - 11. The Romanticist"
 *     epTitle: "The Romanticist"
 */
export function formatPlayerEpisodeLabel(
  rawShowTitle?: string,
  rawEpisodeTitle?: string,
  episodeNum?: number,
  seasonNum?: number
): {
  primary: string;
  secondary: string;
  full: string;
  epTitle: string;
} {
  let showTitle = sanitizeShowTitle(rawShowTitle);
  let epRaw = (rawEpisodeTitle || '').trim();

  // If showTitle is not provided, strip provider prefixes first so "D+ - Moving - ..." doesn't split on "D+ - "
  if (!showTitle && epRaw) {
    const stripped = stripProviderPrefixes(epRaw);
    const splitIdx = stripped.indexOf(' - ');
    if (splitIdx !== -1) {
      showTitle = sanitizeShowTitle(stripped.substring(0, splitIdx));
      epRaw = stripped.substring(splitIdx + 3).trim();
    } else {
      epRaw = stripped;
    }
  }

  let resolvedEpNum = episodeNum;
  if ((resolvedEpNum == null || resolvedEpNum <= 0) && epRaw) {
    const m = epRaw.match(/\b(?:e|ep|episode)[\s._-]*(\d{1,3})\b/i) ||
              epRaw.match(/\b\d{1,2}x(\d{1,3})\b/i) ||
              epRaw.match(/\bS\d{1,2}\s*E(\d{1,3})\b/i);
    if (m) {
      resolvedEpNum = parseInt(m[1], 10);
    }
  }

  const epTitle = sanitizeEpisodeTitle(epRaw, showTitle, resolvedEpNum, seasonNum);

  let secondary = '';
  if (resolvedEpNum != null && resolvedEpNum > 0) {
    if (epTitle && epTitle.toLowerCase() !== `episode ${resolvedEpNum}`.toLowerCase()) {
      secondary = `- ${resolvedEpNum}. ${epTitle}`;
    } else {
      secondary = `- Episode ${resolvedEpNum}`;
    }
  } else if (epTitle) {
    secondary = `- ${epTitle}`;
  }

  const full = showTitle ? (secondary ? `${showTitle} ${secondary}` : showTitle) : (secondary.replace(/^-\s*/, '') || epRaw);
  return { primary: showTitle, secondary, full, epTitle };
}
