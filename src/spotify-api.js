// ---------------------------------------------------------------------------
// spotify-api.js — find a track by name.
//
// THE INSIGHT THAT MAKES THIS EASY:
//
// Playing a NAMED song looks like it needs a full user login. It doesn't,
// because the job splits into two halves that need different things:
//
//   "which track is 'Blinding Lights by The Weeknd'?"   -> public catalogue
//   "start playing spotify:track:0VjIjW..."             -> the app on this Mac
//
// The first half is public data. Spotify's CLIENT CREDENTIALS flow gives you
// search with just an app ID and secret — no browser, no consent screen, no
// refresh tokens. The second half is AppleScript, which already works.
//
// So a two-minute setup replaces an OAuth implementation.
//
// GENERAL LESSON: when a feature seems to demand heavy machinery, split it
// into the part that needs identity and the part that doesn't. Often only a
// sliver actually needs the login, and sometimes — like here — that sliver
// turns out to be handled by something you already have.
//
// WHAT STILL NEEDS A REAL LOGIN: anything about YOU rather than the
// catalogue — Liked Songs, your playlists, your listening history. Those live
// behind your account and no client-credentials token will reach them.
// ---------------------------------------------------------------------------

import { config } from "./config.js";

let cached = { token: null, expires: 0 };

/**
 * Client-credentials token, cached until shortly before it expires.
 *
 * Caching matters more than it looks: without it every command spends a
 * round-trip re-authenticating, which on a voice assistant is the difference
 * between feeling instant and feeling broken. The 60-second safety margin
 * avoids the classic bug where a token expires in flight and one request in
 * a few hundred fails for no visible reason.
 */
async function getToken() {
  if (cached.token && Date.now() < cached.expires) return cached.token;

  if (!config.spotifyId || !config.spotifySecret) {
    throw new Error(
      "Spotify search needs credentials.\n" +
      "      1. developer.spotify.com/dashboard -> Create app (any name, any redirect URI)\n" +
      "      2. Copy the Client ID and Client Secret\n" +
      "      3. Put them in .env as SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET\n" +
      "      Takes two minutes and is free.",
    );
  }

  const basic = Buffer.from(`${config.spotifyId}:${config.spotifySecret}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`,
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    throw new Error(
      `Spotify rejected those credentials (${res.status}). Check SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env.`,
    );
  }

  const data = await res.json();
  cached = {
    token: data.access_token,
    expires: Date.now() + (data.expires_in - 60) * 1000,
  };
  return cached.token;
}

/**
 * Search the public catalogue.
 * @returns {Promise<Array<{uri,name,artist,album}>>}
 */
export async function searchTracks(query, { limit = 5 } = {}) {
  const token = await getToken();
  const url =
    "https://api.spotify.com/v1/search?type=track&limit=" +
    limit +
    "&q=" +
    encodeURIComponent(query);

  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Spotify search failed (${res.status}).`);

  const data = await res.json();
  return (data.tracks?.items || []).map((t) => ({
    uri: t.uri,
    name: t.name,
    artist: (t.artists || []).map((a) => a.name).join(", "),
    album: t.album?.name,
    popularity: t.popularity,
  }));
}

/**
 * "the most popular song by X" — search the artist, sort by popularity.
 *
 * Spotify's own relevance ranking is not popularity ranking, so asking for
 * "most viewed" and taking the first search hit gives the wrong answer
 * confidently. Sorting explicitly by the popularity field is the difference
 * between plausible and correct — and a voice assistant that is confidently
 * wrong is worse than one that admits it doesn't know.
 */
export async function topTrackByArtist(artist) {
  const tracks = await searchTracks(`artist:${artist}`, { limit: 20 });
  if (!tracks.length) return null;
  return tracks.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))[0];
}
