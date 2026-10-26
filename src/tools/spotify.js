import { config } from "../config.js";

// Plain-fetch Spotify client. The spotify-web-api-node package is
// unmaintained and still calls /playlists/{id}/tracks, which Spotify retired
// on 2026-02-11 in favor of /playlists/{id}/items (old path now 403s).
//
// Refresh-token flow: the access token is refreshed lazily before each
// request and cached until expiry. Requires scopes: playlist-modify-public,
// playlist-modify-private, playlist-read-private.

const ACCOUNTS_URL = "https://accounts.spotify.com/api/token";
const API_URL = "https://api.spotify.com/v1";

let accessToken = null;
let tokenExpiresAt = 0;

async function ensureAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt - 30_000) return;

  const res = await fetch(ACCOUNTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " +
        Buffer.from(`${config.spotify.clientId}:${config.spotify.clientSecret}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: config.spotify.refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`Spotify token refresh failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
}

async function spotifyFetch(path, options = {}) {
  await ensureAccessToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`Spotify API error on ${path}: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function resolvePlaylistId(playlistName) {
  if (!playlistName) return config.spotify.defaultPlaylistId;

  const data = await spotifyFetch("/me/playlists?limit=50");
  const match = data.items.find((p) => p.name.toLowerCase() === playlistName.toLowerCase());
  return match?.id ?? config.spotify.defaultPlaylistId;
}

// A track link (open.spotify.com/track/<id>, also with an /intl-xx/ segment)
// or a spotify:track:<id> URI names the exact track, so it skips the search.
const TRACK_LINK_RE = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/|spotify:track:)([A-Za-z0-9]{22})/i;

async function findTrack(songQuery) {
  const trackId = songQuery.match(TRACK_LINK_RE)?.[1];
  if (trackId) {
    try {
      return await spotifyFetch(`/tracks/${trackId}`);
    } catch (err) {
      // A bad or unknown id is a miss, not a failure of the tool.
      if (/: (400|404) /.test(err.message)) return null;
      throw err;
    }
  }
  const search = await spotifyFetch(
    `/search?${new URLSearchParams({ q: songQuery, type: "track", limit: "1" })}`
  );
  return search.tracks?.items?.[0] ?? null;
}

/**
 * Find a track (by link or by search) and add it to a playlist.
 * Returns { added, text }: text is the human-readable confirmation or miss.
 */
export async function addToPlaylist(songQuery, playlistName) {
  if (!config.spotify.clientId || !config.spotify.refreshToken) {
    throw new Error("Spotify is not configured");
  }

  const track = await findTrack(songQuery);
  if (!track) {
    return { added: false, text: `No Spotify track found for "${songQuery}".` };
  }

  const playlistId = await resolvePlaylistId(playlistName);
  if (!playlistId) {
    throw new Error("No playlist ID resolved and SPOTIFY_DEFAULT_PLAYLIST_ID is unset");
  }

  await spotifyFetch(`/playlists/${playlistId}/items`, {
    method: "POST",
    body: JSON.stringify({ uris: [track.uri] }),
  });

  const artists = track.artists.map((a) => a.name).join(", ");
  const playlistUrl = `https://open.spotify.com/playlist/${playlistId}`;
  return { added: true, text: `🎵 Added "${track.name}" by ${artists} to the playlist.\n${playlistUrl}` };
}
