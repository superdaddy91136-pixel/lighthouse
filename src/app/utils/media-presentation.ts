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

    // Platform prefixes: 4K-NF, NF, ATVP, AMZN, DSNP, HMAX, MAX, HBO, HULU, BBC, etc.
    title = title.replace(
      /^[-*#~_+=|\s]*\b(4K-)?(NF|ATVP|AMZN|DSNP|HMAX|MAX|HBO|HULU|DISNEY\+?|APPLE|PARAMOUNT\+?|PEACOCK|BBC)\b[-*#~_+=|\s:]*/i,
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
