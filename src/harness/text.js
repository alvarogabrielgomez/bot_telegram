// Text matching helpers: accent- and case-insensitive tokens for memory search.

export const normalize = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// Tokens of 2+ characters; single letters carry no signal for matching.
export const tokenize = (s) =>
  normalize(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
