// ONLY sponsors public on GitHub — a private sponsorship must never be published here; never store amounts (GitHub doesn't publish them) — `top` only records which side of $49 they fall on

export type Sponsor = {
  login: string;
  name: string;
  avatarUrl: string;
  // top = $49/mo+ or a $49+ one-time gift — drives listing order and the Top donors group; leave off for everyone else
  top?: boolean;
  since?: string;
  websiteUrl?: string;
  logoUrl?: string;
};

export const SPONSORS: readonly Sponsor[] = [
  {
    login: "sandeshapparala",
    name: "Sandesh Apparala",
    avatarUrl: "https://avatars.githubusercontent.com/u/138796263?v=4",
    since: "Aug 4, 2026",
  },
  {
    login: "aristotl-dylan",
    name: "aristotl-dylan",
    avatarUrl: "https://avatars.githubusercontent.com/u/247120692?v=4",
    top: true,
    since: "Aug 3, 2026",
  },
  {
    login: "lassejlv",
    name: "Lasse",
    avatarUrl: "https://avatars.githubusercontent.com/u/77295879?v=4",
    since: "Aug 3, 2026",
    websiteUrl: "https://lassejlv.dk",
  },
  {
    login: "Howardedu",
    name: "Howardedu",
    avatarUrl: "https://avatars.githubusercontent.com/u/99465200?v=4",
    top: true,
    since: "Aug 3, 2026",
  },
  {
    login: "m-vts",
    name: "m-vts",
    avatarUrl: "https://avatars.githubusercontent.com/u/43476645?v=4",
    top: true,
    since: "Aug 2, 2026",
  },
];
