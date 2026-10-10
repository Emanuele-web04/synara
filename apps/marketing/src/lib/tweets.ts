// react-tweet's fetchTweet wrapped in unstable_cache so the homepage shows real author/avatar/text/likes — falls back to seed data on fetch failure

import { unstable_cache } from "next/cache";
import { fetchTweet, type Tweet } from "react-tweet/api";
import { TESTIMONIALS, type TestimonialTier } from "@/data/testimonials";

const DEFAULT_TWEET_CACHE_TTL_SECONDS = 900;

export interface TestimonialCard {
  id: string;
  tier: TestimonialTier;
  name: string;
  handle: string;
  avatarUrl: string | null;
  text: string;
  url: string;
  likes: number | null;
  verified: boolean;
  image: { src: string; alt: string } | null;
  translation: string | null;
  translationLang: string | null;
  live: boolean;
}

export function isValidTweetId(tweetId: string): boolean {
  return /^[0-9]+$/.test(tweetId) && tweetId.length <= 40;
}

function getTweetCacheTtlSeconds(envValue = process.env.TWEET_CACHE_TTL_SECONDS): number {
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TWEET_CACHE_TTL_SECONDS;
  }
  return Math.floor(parsed);
}

const fetchCachedTweet = unstable_cache(
  async (tweetId: string) => fetchTweet(tweetId),
  ["synara-testimonial-tweet"],
  { revalidate: getTweetCacheTtlSeconds() },
);

// Twitter serves a tiny `_normal` avatar by default; request the crisp variant.
function upscaleAvatar(url: string): string {
  return url.replace("_normal.", "_400x400.");
}

function firstPhoto(tweet: Tweet): { src: string; alt: string } | null {
  const photo = tweet.mediaDetails?.find((media) => media.type === "photo");
  if (!photo) return null;
  return {
    src: photo.media_url_https,
    alt: photo.ext_alt_text ?? `Media shared by @${tweet.user.screen_name}`,
  };
}

function fixtureCard(seed: (typeof TESTIMONIALS)[number]): TestimonialCard {
  return {
    id: seed.id,
    tier: seed.tier,
    name: seed.fallbackHandle,
    handle: seed.fallbackHandle,
    avatarUrl: null,
    text: seed.fallbackText,
    url: seed.fallbackUrl,
    likes: null,
    verified: false,
    image: null,
    translation: seed.translation ?? null,
    translationLang: seed.translationLang ?? null,
    live: false,
  };
}

export async function loadTestimonialCards(): Promise<TestimonialCard[]> {
  if (process.env.VISUAL_TEST === "1") {
    return TESTIMONIALS.map(fixtureCard);
  }

  const cards = await Promise.all(
    TESTIMONIALS.map(async (seed): Promise<TestimonialCard> => {
      const fallback: TestimonialCard = {
        id: seed.id,
        tier: seed.tier,
        name: seed.fallbackHandle,
        handle: seed.fallbackHandle,
        avatarUrl: null,
        text: seed.fallbackText,
        url: seed.fallbackUrl,
        likes: null,
        verified: false,
        image: null,
        translation: seed.translation ?? null,
        translationLang: seed.translationLang ?? null,
        live: false,
      };

      if (!isValidTweetId(seed.id)) return fallback;

      try {
        let payload: Awaited<ReturnType<typeof fetchTweet>>;
        try {
          payload = await fetchCachedTweet(seed.id);
        } catch {
          // Environments without the Next data cache still serve fresh data.
          payload = await fetchTweet(seed.id);
        }

        const tweet = payload.data;
        if (!tweet || payload.notFound || payload.tombstone) return fallback;

        return {
          id: seed.id,
          tier: seed.tier,
          name: tweet.user.name,
          handle: tweet.user.screen_name,
          avatarUrl: upscaleAvatar(tweet.user.profile_image_url_https),
          text: tweet.text,
          url: `https://x.com/${tweet.user.screen_name}/status/${tweet.id_str}`,
          likes: tweet.favorite_count ?? null,
          verified: tweet.user.verified || tweet.user.is_blue_verified,
          image: firstPhoto(tweet),
          translation: seed.translation ?? null,
          translationLang: seed.translationLang ?? null,
          live: true,
        };
      } catch {
        return fallback;
      }
    }),
  );

  return cards;
}
