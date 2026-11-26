// The team's units as of the "Peninsula Stars · Team Performance" report, 20–26 Nov 2026.
// Applied once to the offers (see schema.js). Floors are shown; unit numbers are not part of offers.
export const UPDATES = {
  // Giulia Perego · 8
  "p1-3bed-maid": { agent: "giulia" },
  "p2-studio-80": { agent: "giulia", size: 406 },
  "p2-1bed-688": { agent: "giulia" },
  "p3-studio-33": { agent: "giulia", size: 413 },
  "p3-1bed-674": { agent: "giulia" },
  "p3-2bed-1011": { agent: "giulia", deal: "both", price: 3100000, rent: 220000 },
  "p4-1bed-861": { agent: "giulia" },
  "p5-studio-120": { agent: "giulia" },
  // Talal Al Deraawi · 4
  "p3-studio-f6": { agent: "talal", size: 410 },
  "p4-studio-100": { agent: "talal" },
  "p5-2bed-1307": { agent: "talal", price: 4500000 },
  // Blendjana · 3
  "p4-1bed-553": { agent: "blendjana" },
  "p4-2bed-1453": { agent: "blendjana", price: 4600000 }
};
export const NEW = {
  "p2-2bed-949": { b: 2, beds: 2, deal: "sale", title: "2 bed, mid floor", price: 4000000, size: 949, floor: "Mid floor", view: "On request", furn: "—", baths: 2, status: "Ready", agent: "blendjana", hl: "", src: "Team performance report" },
  "p1-2bed-927": { b: 1, beds: 2, deal: "sale", title: "2 bed, mid floor", price: 2400000, size: 927, floor: "Mid floor", view: "On request", furn: "—", baths: 2, status: "Ready", agent: "derya", hl: "", src: "Team performance report" }
};
export const PHONES = { derya: "+971 58 177 3724", love: "+971 56 800 0815" };
export const PLATFORMS = [{ k: "bayut", n: "Bayut" }, { k: "pf", n: "Property Finder" }];
